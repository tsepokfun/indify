/**
 * 任务编排:驱动 DSH 会话按 skill 协议产出 IR/YAML,并实现 HITL 状态机。
 *
 * 会话协议(与 skill 的 SKILL.md 对齐):
 *   Prompt#1(create):生成 IR → 写 generated/{taskId}/ir.json → 写 result.json{status:"draft-ready"}
 *   Prompt#2(approve):ir.json → workflow.yaml(经 skill 的 ir_to_dsl 脚本)→ result.json{status:"ready"}
 *   Prompt#2(revise):按反馈改 ir.json → result.json 保持 draft-ready
 *
 * Bridge 只读 Agent 产物,只写 task.json(见 DESIGN §9)。
 */
import { DshClient } from './dsh.js';
import { TaskStore, type Task } from './tasks.js';
import type { BridgeConfig } from './config.js';

const TURN_TIMEOUT_MS = 10 * 60_000;

function buildCreatePrompt(task: Task): string {
  return [
    `你是 Indify 的 Builder Agent(工作区 D:\\difyIndify,任务 ID ${task.taskId})。`,
    '',
    '【必读】开始前先读取并严格遵守 D:\\difyIndify\\skills\\dify-workflow-dsl\\SKILL.md;',
    '结构细节按需查阅 D:\\difyIndify\\skills\\dify-workflow-dsl\\references\\dify-1.16\\ 下的参考文档。',
    '',
    `【任务】mode=create。用户需求(原话):${task.spec}`,
    '',
    '【执行步骤】',
    `1) 设计工作流 IR(只处理结构语义:节点/连边/变量绑定;不要手写 YAML);`,
    `2) 将 IR 写入 D:\\difyIndify\\generated\\${task.taskId}\\ir.json;`,
    `3) 用 node D:\\difyIndify\\skills\\dify-workflow-dsl\\scripts\\validate.mjs 校验 IR(用法见 SKILL.md),不通过则修正;`,
    `4) 写 D:\\difyIndify\\generated\\${task.taskId}\\result.json,内容恰为 {"status":"draft-ready","summary":"<一句中文,描述你将生成的工作流结构>","warnings":[]}。`,
    '',
    '【纪律】',
    '- 只写 D:\\difyIndify\\generated\\${taskId}\\ 目录,不要动其他文件;',
    '- 不要调用提问/审批类工具(ask_user_question 等),信息不足时做合理假设并写入 warnings;',
    '- 不要自己拼接 DSL YAML 字段名或 {{#...#}} 引用语法,转换一律交给 skill 脚本;',
    '- 最终只回复一句简短中文说明(用户将在扩展里看到你的摘要)。',
  ].join('\n');
}

function buildApprovePrompt(task: Task): string {
  return [
    `Indify 任务 ${task.taskId}:用户已【确认】预览结构。现在:`,
    `1) 用 skill 脚本把 IR 转成 DSL YAML:` +
      `node D:\\difyIndify\\skills\\dify-workflow-dsl\\scripts\\ir_to_dsl.mjs D:\\difyIndify\\generated\\${task.taskId}\\ir.json D:\\difyIndify\\generated\\${task.taskId}\\workflow.yaml`,
    `2) 再用 validate.mjs 校验生成的 workflow.yaml;`,
    `3) 更新 D:\\difyIndify\\generated\\${task.taskId}\\result.json 为 {"status":"ready","summary":"<一句中文>","warnings":[]}。`,
    '回复一句简短中文。',
  ].join('\n');
}

function buildRevisePrompt(task: Task, feedback: string): string {
  return [
    `Indify 任务 ${task.taskId}:用户对预览结构提出修改意见:「${feedback}」。`,
    `请修改 D:\\difyIndify\\generated\\${task.taskId}\\ir.json(沿用 skill 规则与语义约束),重新用 validate.mjs 校验,`,
    `并更新 result.json(保持 {"status":"draft-ready",...} 与新的 summary)。回复一句简短中文。`,
  ].join('\n');
}

export class Orchestrator {
  private running = false;

  constructor(
    private readonly dsh: DshClient,
    private readonly store: TaskStore,
    private readonly cfg: BridgeConfig,
  ) {}

  /** 非阻塞踢动:若有排队任务且当前空闲,开始跑下一个。 */
  kick(): void {
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = [...this.store.values()].find((t) => t.status === 'queued');
    if (!next) return;
    this.running = true;
    try {
      await this.runTask(next.taskId);
    } finally {
      this.running = false;
      // 串行队列:继续下一个
      setImmediate(() => this.pump());
    }
  }

  /** 从头跑一个任务(queued → … → ready/draft-ready)。 */
  async runTask(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    try {
      const sessionId = task.sessionId ?? (await this.dsh.createSession(this.cfg.workspaceRoot));
      task.sessionId = sessionId;
      this.store.transition(taskId, 'agent-running', { sessionId, phase: 'Agent 生成中(设计 IR)' });

      await this.promptAndWait(task, buildCreatePrompt(task));
      const result1 = this.store.readResult(taskId);
      if (!result1) throw new Error('Agent 未产出 result.json');
      if (result1.status === 'failed') throw new Error(result1.summary || 'Agent 报告失败');
      if (result1.status !== 'draft-ready') throw new Error(`意外 result.json 状态: ${result1.status ?? '(空)'}`);
      this.store.transition(taskId, 'draft-ready', { phase: '等待用户确认', summary: result1.summary });
    } catch (e) {
      this.fail(taskId, e);
    }
  }

  /** HITL 决策入口(approve / revise)。 */
  async decide(taskId: string, action: 'approve' | 'revise', feedback?: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'draft-ready') throw new Error(`任务状态为 ${task.status},不接受决策`);
    if (!task.sessionId) throw new Error('任务缺少会话,无法续聊');
    try {
      if (action === 'approve') {
        this.store.transition(taskId, 'finalizing', { phase: '生成终稿 YAML 中' });
        await this.promptAndWait(task, buildApprovePrompt(task));
        const result = this.store.readResult(taskId);
        if (!result || result.status !== 'ready') throw new Error('Agent 未产出 status=ready 的 result.json');
        const yaml = this.store.readArtifact(taskId, 'workflow.yaml');
        if (!yaml) throw new Error('workflow.yaml 缺失');
        this.store.transition(taskId, 'ready', {
          phase: '已就绪,等待注入',
          summary: result.summary,
          artifact: { file: 'workflow.yaml', bytes: yaml.length },
        });
      } else {
        const fb = (feedback ?? '').trim() || '请改进';
        this.store.transition(taskId, 'agent-running', { phase: '按反馈修改 IR 中' });
        await this.promptAndWait(task, buildRevisePrompt(task, fb));
        const result = this.store.readResult(taskId);
        if (!result || result.status !== 'draft-ready') throw new Error('Agent 未回到 draft-ready');
        this.store.transition(taskId, 'draft-ready', { phase: '等待用户确认', summary: result.summary });
      }
    } catch (e) {
      this.fail(taskId, e);
    }
  }

  /** 注入完成回报(扩展侧成功导入后调用)。 */
  markInjected(taskId: string, appId?: string, appUrl?: string): void {
    this.store.transition(taskId, 'done', { phase: '完成', appId, appUrl });
  }

  private async promptAndWait(task: Task, text: string): Promise<void> {
    const beforeTurn = await this.dsh.lastTurnNumber(task.sessionId!);
    await this.dsh.prompt(task.sessionId!, text);
    await this.dsh.waitTurnEnd(task.sessionId!, beforeTurn, TURN_TIMEOUT_MS);
  }

  private fail(taskId: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[bridge] 任务 ${taskId} 失败:`, message);
    this.store.transition(taskId, 'failed', { phase: '失败', error: message });
  }
}
