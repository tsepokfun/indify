/**
 * 任务编排(v2 两段式):驱动 DSH 会话按 skill 协议产出计划 → IR/YAML/graph,并实现 HITL 状态机。
 *
 * 状态机:queued → planning → plan-ready → building → draft-ready → finalizing → ready → injecting → done | failed
 *   plan-ready --revise-plan--> planning(循环修订计划)
 *   draft-ready --revise--> agent-running(结构迭代)
 *
 * 会话协议(与 skill 的 SKILL.md §2.2 对齐):
 *   Prompt#1(计划):写 generated/{taskId}/plan.txt + result.json{status:"plan-ready"}
 *   Prompt#2(build):以 plan-final.txt(用户最终计划,唯一权威)为准执行构建:
 *     create:ir.json + result.json{status:"draft-ready"} / modify:graph.json + result.json{status:"draft-ready"}
 *   Prompt#2(revise-plan):按用户反馈重写 plan.txt → 回 plan-ready
 *   Prompt#3(approve):create 走 ir_to_dsl 产 workflow.yaml;modify 校验定稿 graph.json → result.json{status:"ready"}
 *   Prompt#3(revise):按反馈改结构 → 回 draft-ready
 *
 * Bridge 只读 Agent 产物;仅写 task.json、current-graph.json、plan-final.txt、plan-feedback.txt
 * (plan-final/plan-feedback 是用户决策文本的落盘,见 docs/upgrade-plan-v2.md 特性二)。
 * 跨平台:所有提示词路径由 workspaceRoot 动态生成(Windows 反斜杠 / POSIX 斜杠)。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DshClient } from './dsh.js';
import { TaskStore, type Task } from './tasks.js';
import type { BridgeConfig } from './config.js';

const TURN_TIMEOUT_MS = 10 * 60_000;
// 版本防波堤纪律:这里绝不出现任何 Dify 版本号 / DSL 版本号 / 版本化参考目录名。
// 版本细节(参考目录、节点白名单、字段)由 SKILL.md 与 adapter 声明,Agent 按 SKILL.md 的指针查阅。

let SKILL_MD = '';
let VALIDATE = '';
let IR_TO_DSL = '';
let GEN_ROOT = '';
let WORKSPACE = '';

/** 由 server.ts 启动时调用,把工作区根注入提示词路径(跨平台)。 */
export function initPromptPaths(workspaceRoot: string): void {
  WORKSPACE = workspaceRoot;
  SKILL_MD = join(workspaceRoot, 'skills', 'dify-workflow-dsl', 'SKILL.md');
  VALIDATE = join(workspaceRoot, 'skills', 'dify-workflow-dsl', 'scripts', 'validate.mjs');
  IR_TO_DSL = join(workspaceRoot, 'skills', 'dify-workflow-dsl', 'scripts', 'ir_to_dsl.mjs');
  GEN_ROOT = join(workspaceRoot, 'generated');
}

function taskDir(task: Task): string {
  return join(GEN_ROOT, task.taskId);
}

/** 附件清单说明块(F1 接入;无附件时为空)。 */
function attachmentBlock(task: Task): string {
  const att = task.attachments;
  if (!att || att.length === 0) return '';
  const lines = att.map((a) => `- ${a.name}(${a.kind}):${a.textPath ?? a.path}`);
  return ['', '【附件】(已落盘到任务目录 attachments/ 与下述文本文件,设计前先读取相关文件):', ...lines].join('\n');
}

function buildPlanPrompt(task: Task): string {
  const dir = taskDir(task);
  const modeLine =
    task.mode === 'modify'
      ? [
          `【任务】mode=modify。用户对当前打开的工作流提出修改要求(原话):${task.spec}`,
          `当前草稿 graph 已由 Bridge 写入 ${join(dir, 'current-graph.json')},请先读取它理解现有结构。`,
        ].join('\n')
      : `【任务】mode=create。用户需求(原话):${task.spec}`;
  return [
    `你是 Indify 的 Builder Agent(工作区 ${WORKSPACE},任务 ID ${task.taskId})。`,
    '',
    `【必读】开始前先读取并严格遵守 ${SKILL_MD},尤其「§2.2 计划-构建两段式流程」一节;`,
    '结构细节按需查阅 SKILL.md 中声明的「当前版本 references 目录」(SKILL.md 会指出该目录的确切路径)。',
    '',
    modeLine,
    attachmentBlock(task),
    '',
    '【本阶段任务:只写实施计划,不要生成任何 IR / YAML / graph】',
    `1) 把需求翻译成一份中文实施计划(markdown 纯文本),写入 ${join(dir, 'plan.txt')};`,
    '2) 计划必须包含:目标概述、节点清单(每个节点的语义类型/职责/关键配置)、',
    '   连边与数据流(变量绑定、控制流)、modify 模式的改动清单(增/删/改哪些节点与连线)、验收要点;',
    `3) 写 ${join(dir, 'result.json')},内容恰为 {"status":"plan-ready","summary":"<一句中文,概括本计划>","warnings":[]}。`,
    '',
    '【纪律】',
    `- 只写 ${dir} 目录下的 plan.txt 与 result.json,不要产出 ir.json / workflow.yaml / graph.json;`,
    '- 计划用中文;这是给用户审阅的可编辑文本,结构清晰、不要炫技;',
    '- 不要调用提问/审批类工具(ask_user_question 等),信息不足时做合理假设并写入 warnings;',
    '- 最终只回复一句简短中文说明(用户将在扩展里看到你的摘要)。',
  ].join('\n');
}

function buildFromPlanPrompt(task: Task): string {
  const dir = taskDir(task);
  if (task.mode === 'modify') {
    return [
      `Indify 任务 ${task.taskId}:用户已确认最终计划并点「开始构建」。`,
      `用户的最终计划文本(可能含手改)已由 Bridge 写入 ${join(dir, 'plan-final.txt')},它是唯一权威。`,
      '',
      '现在执行构建(遵守 SKILL.md §2.2 第 ② 步):',
      `1) 读取 ${join(dir, 'plan-final.txt')},以它为准制定修改方案;`,
      `2) 读取 ${join(dir, 'current-graph.json')},按计划直接修改 graph(保真纪律见 SKILL.md §2.1):`,
      '   新增/删除节点与边、修改节点 data 或连线;',
      `3) 把新 graph 写入 ${join(dir, 'graph.json')};`,
      `4) 用 node ${VALIDATE} ${join(dir, 'graph.json')} --graph 校验,不通过则修正;`,
      `5) 写 ${join(dir, 'result.json')},内容恰为 {"status":"draft-ready","summary":"<一句中文,说明本次改动>","warnings":[]}。`,
      '',
      '【纪律】',
      `- 只写 ${dir} 目录;保真优先:未触及节点的 data/canvas、边的 data/zIndex、viewport 一律原样保留;`,
      '- 构建时若与计划有合理偏差,写进 result.json 的 warnings 说明;',
      '- 不要把 graph 转成 YAML 导入(那只会新建应用),修改只走草稿写回;',
      '- 最终只回复一句简短中文。',
    ].join('\n');
  }
  return [
    `Indify 任务 ${task.taskId}:用户已确认最终计划并点「开始构建」。`,
    `用户的最终计划文本(可能含手改)已由 Bridge 写入 ${join(dir, 'plan-final.txt')},它是唯一权威。`,
    '',
    '现在执行构建(遵守 SKILL.md §2.2 第 ② 步):',
    `1) 读取 ${join(dir, 'plan-final.txt')},以它为准设计工作流 IR(只处理结构语义:节点/连边/变量绑定;不要手写 YAML);`,
    `2) 将 IR 写入 ${join(dir, 'ir.json')};`,
    `3) 用 node ${VALIDATE} ${join(dir, 'ir.json')} 校验,不通过则修正;`,
    `4) 写 ${join(dir, 'result.json')},内容恰为 {"status":"draft-ready","summary":"<一句中文,描述你将生成的工作流结构>","warnings":[]}。`,
    '',
    '【纪律】',
    `- 只写 ${dir} 目录,不要动其他文件;`,
    '- 构建时若与计划有合理偏差,写进 result.json 的 warnings 说明;',
    '- 不要自己拼接 DSL YAML 字段名或 {{#...#}} 引用语法,转换一律交给 skill 脚本;',
    '- 最终只回复一句简短中文说明。',
  ].join('\n');
}

function buildRevisePlanPrompt(task: Task, feedback: string): string {
  const dir = taskDir(task);
  return [
    `Indify 任务 ${task.taskId}:用户要求修订计划(文本框全文如下,请综合它重写):`,
    '```',
    feedback,
    '```',
    '',
    '请执行(遵守 SKILL.md §2.2 第 ③ 步):',
    `1) 重写 ${join(dir, 'plan.txt')}:中文实施计划(markdown),完整覆盖修订后的方案,`,
    '   保留原有计划中未被推翻的部分;',
    `2) 更新 ${join(dir, 'result.json')} 为 {"status":"plan-ready","summary":"<一句中文,概括新计划>","warnings":[]}。`,
    '回复一句简短中文。',
  ].join('\n');
}

function buildApprovePrompt(task: Task): string {
  const dir = taskDir(task);
  if (task.mode === 'modify') {
    return [
      `Indify 任务 ${task.taskId}:用户已【确认】修改方案。现在:`,
      `1) 再跑一次 node ${VALIDATE} ${join(dir, 'graph.json')} --graph,确认有效;`,
      `2) 更新 ${join(dir, 'result.json')} 为 {"status":"ready","summary":"<一句中文>","warnings":[]}。`,
      '回复一句简短中文。',
    ].join('\n');
  }
  return [
    `Indify 任务 ${task.taskId}:用户已【确认】预览结构。现在:`,
    `1) 用 skill 脚本把 IR 转成 DSL YAML:` +
      `node ${IR_TO_DSL} ${join(dir, 'ir.json')} ${join(dir, 'workflow.yaml')}`,
    `2) 再用 validate.mjs 校验生成的 workflow.yaml;`,
    `3) 更新 ${join(dir, 'result.json')} 为 {"status":"ready","summary":"<一句中文>","warnings":[]}。`,
    '回复一句简短中文。',
  ].join('\n');
}

function buildRevisePrompt(task: Task, feedback: string): string {
  const dir = taskDir(task);
  const file = task.mode === 'modify' ? 'graph.json' : 'ir.json';
  const extra = task.mode === 'modify' ? '(裸 graph 对象,校验用 --graph)' : '';
  return [
    `Indify 任务 ${task.taskId}:用户对预览结构提出修改意见:「${feedback}」。`,
    `请修改 ${join(dir, file)}(沿用 skill 规则与语义约束),重新校验${extra},`,
    `并更新 result.json(保持 {"status":"draft-ready",...} 与新的 summary)。回复一句简短中文。`,
  ].join('\n');
}

export type DecisionAction = 'approve' | 'revise' | 'build' | 'revise-plan';

export class Orchestrator {
  private running = false;

  constructor(
    private readonly dsh: DshClient,
    private readonly store: TaskStore,
    private readonly cfg: BridgeConfig,
  ) {
    initPromptPaths(cfg.workspaceRoot);
  }

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

  /** 从头跑一个任务(queued → planning → plan-ready)。 */
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
      }

      // 阶段一:计划(create 与 modify 都走)
      this.store.transition(taskId, 'planning', { sessionId, phase: 'Agent 制定计划中' });
      await this.promptAndWait(task, buildPlanPrompt(task));

      const result1 = this.store.readResult(taskId);
      if (!result1) throw new Error('Agent 未产出 result.json');
      if (result1.status === 'failed') throw new Error(result1.summary || 'Agent 报告失败');
      if (result1.status !== 'plan-ready') throw new Error(`意外 result.json 状态: ${result1.status ?? '(空)'}(期望 plan-ready)`);
      const plan = this.store.readArtifact(taskId, 'plan.txt');
      if (!plan || plan.toString('utf8').trim().length === 0) throw new Error('Agent 未产出非空 plan.txt');

      this.store.transition(taskId, 'plan-ready', {
        phase: '等待确认计划',
        summary: result1.summary,
        artifact: { file: 'plan.txt', bytes: plan.length },
      });
    } catch (e) {
      this.fail(taskId, e);
    }
  }

  /**
   * HITL 决策入口(非 async:守卫错误同步抛出,调用方可立即 409)。
   *   plan-ready → build(planText 唯一权威)/ revise-plan(feedback)
   *   draft-ready → approve / revise
   */
  decide(taskId: string, action: DecisionAction, opts?: { feedback?: string; planText?: string }): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (!task.sessionId) throw new Error('任务缺少会话,无法续聊');

    if (action === 'build' || action === 'revise-plan') {
      if (task.status !== 'plan-ready') throw new Error(`任务状态为 ${task.status},不接受 ${action}(需 plan-ready)`);
    } else {
      if (task.status !== 'draft-ready') throw new Error(`任务状态为 ${task.status},不接受决策`);
    }
    if (action === 'build' && !(opts?.planText ?? '').trim()) {
      throw new Error('build 需要 planText(用户最终计划文本)');
    }

    return this.runDecision(task, action, opts);
  }

  /** decide() 的异步主体(守卫已过,内部错误一律转 failed)。 */
  private async runDecision(
    task: Task,
    action: DecisionAction,
    opts?: { feedback?: string; planText?: string },
  ): Promise<void> {
    const taskId = task.taskId;
    try {
      if (action === 'build') {
        const planText = (opts?.planText ?? '').trim();
        // 用户最终计划落盘(唯一权威;允许含用户手改)
        writeFileSync(join(taskDir(task), 'plan-final.txt'), planText, 'utf8');

        this.store.transition(taskId, 'building', { phase: '按最终计划构建中' });
        await this.promptAndWait(task, buildFromPlanPrompt(task));
        const result = this.store.readResult(taskId);
        if (!result) throw new Error('Agent 未产出 result.json');
        if (result.status === 'failed') throw new Error(result.summary || 'Agent 报告失败');
        if (result.status !== 'draft-ready') throw new Error(`意外 result.json 状态: ${result.status ?? '(空)'}(期望 draft-ready)`);
        this.store.transition(taskId, 'draft-ready', { phase: '等待用户确认', summary: result.summary });
        return;
      }

      if (action === 'revise-plan') {
        const fb = (opts?.feedback ?? '').trim() || '请改进这份计划';
        writeFileSync(join(taskDir(task), 'plan-feedback.txt'), fb, 'utf8');

        this.store.transition(taskId, 'planning', { phase: 'Agent 修订计划中' });
        await this.promptAndWait(task, buildRevisePlanPrompt(task, fb));
        const result = this.store.readResult(taskId);
        if (!result || result.status !== 'plan-ready') throw new Error('Agent 未回到 plan-ready');
        const plan = this.store.readArtifact(taskId, 'plan.txt');
        if (!plan || plan.toString('utf8').trim().length === 0) throw new Error('Agent 未产出非空 plan.txt');
        this.store.transition(taskId, 'plan-ready', {
          phase: '等待确认计划',
          summary: result.summary,
          artifact: { file: 'plan.txt', bytes: plan.length },
        });
        return;
      }

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
        return;
      }

      // revise(结构预览阶段的修改意见)
      const fb = (opts?.feedback ?? '').trim() || '请改进';
      this.store.transition(taskId, 'agent-running', { phase: '按反馈修改中' });
      await this.promptAndWait(task, buildRevisePrompt(task, fb));
      const result = this.store.readResult(taskId);
      if (!result || result.status !== 'draft-ready') throw new Error('Agent 未回到 draft-ready');
      this.store.transition(taskId, 'draft-ready', { phase: '等待用户确认', summary: result.summary });
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
