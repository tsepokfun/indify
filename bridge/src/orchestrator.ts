/**
 * 任务编排:驱动 DSH 会话按 skill 协议产出 IR/YAML/graph,并实现 HITL 状态机。
 *
 * 会话协议(与 skill 的 SKILL.md 对齐):
 *   create:
 *     Prompt#1:生成 IR → 写 generated/{taskId}/ir.json → result.json{status:"draft-ready"}
 *     Prompt#2(approve):ir.json → workflow.yaml(经 skill 的 ir_to_dsl 脚本)→ result.json{status:"ready"}
 *   modify:
 *     Prompt#1:读 current-graph.json(当前草稿 graph)→ 改 graph → 写 graph.json → result.json{draft-ready}
 *     Prompt#2(approve):校验并定稿 graph.json → result.json{status:"ready"}
 *     Prompt#2(revise):按反馈改 → 回到 draft-ready
 *
 * Bridge 只读 Agent 产物,只写 task.json 与 current-graph.json(见 DESIGN §9)。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DshClient } from './dsh.js';
import { TaskStore, type Task } from './tasks.js';
import type { BridgeConfig } from './config.js';

const TURN_TIMEOUT_MS = 10 * 60_000;
const SKILL_MD = 'D:\\difyIndify\\skills\\dify-workflow-dsl\\SKILL.md';
const VALIDATE = 'D:\\difyIndify\\skills\\dify-workflow-dsl\\scripts\\validate.mjs';

function buildCreatePrompt(task: Task): string {
  return [
    `你是 Indify 的 Builder Agent(工作区 D:\\difyIndify,任务 ID ${task.taskId})。`,
    '',
    `【必读】开始前先读取并严格遵守 ${SKILL_MD};`,
    '结构细节按需查阅 D:\\difyIndify\\skills\\dify-workflow-dsl\\references\\dify-1.16\\ 下的参考文档。',
    '',
    `【任务】mode=create。用户需求(原话):${task.spec}`,
    '',
    '【执行步骤】',
    `1) 设计工作流 IR(只处理结构语义:节点/连边/变量绑定;不要手写 YAML);`,
    `2) 将 IR 写入 D:\\difyIndify\\generated\\${task.taskId}\\ir.json;`,
    `3) 用 node ${VALIDATE} D:\\difyIndify\\generated\\${task.taskId}\\ir.json 校验,不通过则修正;`,
    `4) 写 D:\\difyIndify\\generated\\${task.taskId}\\result.json,内容恰为 {"status":"draft-ready","summary":"<一句中文,描述你将生成的工作流结构>","warnings":[]}。`,
    '',
    '【纪律】',
    `- 只写 D:\\difyIndify\\generated\\${task.taskId}\\ 目录,不要动其他文件;`,
    '- 不要调用提问/审批类工具(ask_user_question 等),信息不足时做合理假设并写入 warnings;',
    '- 不要自己拼接 DSL YAML 字段名或 {{#...#}} 引用语法,转换一律交给 skill 脚本;',
    '- 最终只回复一句简短中文说明(用户将在扩展里看到你的摘要)。',
  ].join('\n');
}

function buildModifyPrompt(task: Task): string {
  return [
    `你是 Indify 的 Builder Agent(工作区 D:\\difyIndify,任务 ID ${task.taskId})。`,
    '',
    `【必读】开始前先读取并严格遵守 ${SKILL_MD},尤其「2.1 修改(modify)流程」一节。`,
    '',
    `【任务】mode=modify。用户对当前打开的工作流提出修改要求(原话):${task.spec}`,
    `当前草稿 graph 已由 Bridge 写入 D:\\difyIndify\\generated\\${task.taskId}\\current-graph.json`,
    '(它就是 DSL 的 workflow.graph:nodes/edges/viewport,节点 data 细节见 references/dify-1.16/node-catalog.md)。',
    '',
    '【执行步骤】',
    `1) 读取 current-graph.json,理解现有结构;`,
    `2) 直接修改 graph(保真纪律见 SKILL.md §2.1):新增/删除节点与边、修改节点 data 或连线;`,
    `3) 把新 graph 写入 D:\\difyIndify\\generated\\${task.taskId}\\graph.json;`,
    `4) 用 node ${VALIDATE} D:\\difyIndify\\generated\\${task.taskId}\\graph.json --graph 校验,不通过则修正;`,
    `5) 写 D:\\difyIndify\\generated\\${task.taskId}\\result.json,内容恰为 {"status":"draft-ready","summary":"<一句中文,说明本次改动>","warnings":[]}。`,
    '',
    '【纪律】',
    `- 只写 D:\\difyIndify\\generated\\${task.taskId}\\ 目录,不要动其他文件;`,
    '- 保真优先:未触及节点的 data/canvas、边的 data/zIndex、viewport 一律原样保留;',
    '- 不要调用提问/审批类工具;信息不足时做合理假设并写入 warnings;',
    '- 不要把 graph 转成 YAML 导入(那只会新建应用),修改只走草稿写回;',
    '- 最终只回复一句简短中文说明。',
  ].join('\n');
}

function buildApprovePrompt(task: Task): string {
  if (task.mode === 'modify') {
    return [
      `Indify 任务 ${task.taskId}:用户已【确认】修改方案。现在:`,
      `1) 再跑一次 node ${VALIDATE} D:\\difyIndify\\generated\\${task.taskId}\\graph.json --graph,确认有效;`,
      `2) 更新 D:\\difyIndify\\generated\\${task.taskId}\\result.json 为 {"status":"ready","summary":"<一句中文>","warnings":[]}。`,
      '回复一句简短中文。',
    ].join('\n');
  }
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
  const file = task.mode === 'modify' ? 'graph.json' : 'ir.json';
  const extra = task.mode === 'modify' ? '(裸 graph 对象,校验用 --graph)' : '';
  return [
    `Indify 任务 ${task.taskId}:用户对预览结构提出修改意见:「${feedback}」。`,
    `请修改 D:\\difyIndify\\generated\\${task.taskId}\\${file}(沿用 skill 规则与语义约束),重新校验${extra},`,
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

      if (task.mode === 'modify') {
        const graph = (task.context as { currentGraph?: unknown } | undefined)?.currentGraph;
        if (!graph) throw new Error('modify 任务缺少 context.currentGraph(扩展未读到当前草稿)');
        writeFileSync(
          join(this.cfg.workspaceRoot, 'generated', taskId, 'current-graph.json'),
          JSON.stringify(graph, null, 2),
          'utf8',
        );
        this.store.transition(taskId, 'agent-running', { sessionId, phase: 'Agent 修改中(改 graph)' });
        await this.promptAndWait(task, buildModifyPrompt(task));
      } else {
        this.store.transition(taskId, 'agent-running', { sessionId, phase: 'Agent 生成中(设计 IR)' });
        await this.promptAndWait(task, buildCreatePrompt(task));
      }

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
        this.store.transition(taskId, 'finalizing', { phase: task.mode === 'modify' ? '定稿 graph 中' : '生成终稿 YAML 中' });
        await this.promptAndWait(task, buildApprovePrompt(task));
        const result = this.store.readResult(taskId);
        if (!result || result.status !== 'ready') throw new Error('Agent 未产出 status=ready 的 result.json');
        if (task.mode === 'modify') {
          const graph = this.store.readArtifact(taskId, 'graph.json');
          if (!graph) throw new Error('graph.json 缺失');
          this.store.transition(taskId, 'ready', {
            phase: '已就绪,等待写回草稿',
            summary: result.summary,
            artifact: { file: 'graph.json', bytes: graph.length },
          });
        } else {
          const yaml = this.store.readArtifact(taskId, 'workflow.yaml');
          if (!yaml) throw new Error('workflow.yaml 缺失');
          this.store.transition(taskId, 'ready', {
            phase: '已就绪,等待注入',
            summary: result.summary,
            artifact: { file: 'workflow.yaml', bytes: yaml.length },
          });
        }
      } else {
        const fb = (feedback ?? '').trim() || '请改进';
        this.store.transition(taskId, 'agent-running', { phase: '按反馈修改中' });
        await this.promptAndWait(task, buildRevisePrompt(task, fb));
        const result = this.store.readResult(taskId);
        if (!result || result.status !== 'draft-ready') throw new Error('Agent 未回到 draft-ready');
        this.store.transition(taskId, 'draft-ready', { phase: '等待用户确认', summary: result.summary });
      }
    } catch (e) {
      this.fail(taskId, e);
    }
  }

  /** 注入完成回报(扩展侧成功导入/写回后调用)。 */
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
