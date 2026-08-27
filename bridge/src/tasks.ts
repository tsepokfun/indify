/**
 * 任务存储与状态机。
 * 持久化:generated/{taskId}/task.json(Bridge 只写 task.json;ir.json/workflow.yaml/result.json/plan.txt 由 Agent 写)。
 * 状态机(v2 两段式):queued → planning → plan-ready → building → draft-ready → finalizing → ready → injecting → done | failed
 *         (plan-ready 可经 revise-plan 回 planning 循环;draft-ready 可经 revise 回 agent-running;任何环节出错 → failed)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WORKSPACE_ROOT } from './config.js';

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'plan-ready'
  | 'building'
  | 'agent-running'
  | 'draft-ready'
  | 'finalizing'
  | 'ready'
  | 'injecting'
  | 'done'
  | 'failed';

export interface TaskContext {
  appId?: string;
  appUrl?: string;
  currentGraph?: unknown;
}

/** 附件元信息(F1;任务目录 attachments/ 内的文件)。 */
export interface TaskAttachment {
  name: string; // 原始文件名
  kind: 'pdf' | 'image' | 'text'; // 类别
  path: string; // 相对任务目录的原件路径(attachments/<name>)
  textPath?: string; // 抽文本/OCR 产物路径(attachments/<name>.txt / .ocr.txt),存在才有
}

export interface Task {
  taskId: string;
  mode: 'create' | 'modify';
  spec: string;
  status: TaskStatus;
  phase: string;
  context?: TaskContext;
  sessionId?: string;
  summary?: string;
  error?: string;
  appId?: string;
  appUrl?: string;
  attachments?: TaskAttachment[];
  createdAt: number;
  updatedAt: number;
}

export const ARTIFACT_WHITELIST = new Set(['ir.json', 'workflow.yaml', 'graph.json', 'result.json', 'plan.txt', 'plan-final.txt']);

const GEN_DIR = join(WORKSPACE_ROOT, 'generated');

function taskDir(taskId: string): string {
  return join(GEN_DIR, taskId);
}

function taskFile(taskId: string): string {
  return join(taskDir(taskId), 'task.json');
}

export type FrameEmitter = (frame: { type: string; data: Record<string, unknown> }) => void;

export class TaskStore {
  private tasks = new Map<string, Task>();

  constructor(private readonly emit: FrameEmitter) {}

  loadAll(): void {
    // 启动时扫描 generated/ 恢复上次任务(重启不丢,见 DESIGN §5.2)
    if (!existsSync(GEN_DIR)) return;
    // 只读一层目录,不递归(避免误扫无关目录)
    for (const dir of readdirSync(GEN_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const f = join(GEN_DIR, dir.name, 'task.json');
      if (!existsSync(f)) continue;
      try {
        const t = JSON.parse(readFileSync(f, 'utf8')) as Task;
        // v2 决策:进行中的旧任务不迁移——中断态任务一律转 failed(不会自动续跑)。
        // plan-ready / draft-ready / ready 是稳定的 HITL 等待态,重启后保留,用户可继续操作。
        if (
          t.status === 'queued' ||
          t.status === 'planning' ||
          t.status === 'building' ||
          t.status === 'agent-running' ||
          t.status === 'finalizing'
        ) {
          t.status = 'failed';
          t.error = 'Bridge 重启导致任务中断';
          t.updatedAt = Date.now();
          this.persist(t);
        }
        if (t.status === 'injecting') t.status = 'ready'; // 注入中重启 → 回到 ready 可重试
        this.tasks.set(t.taskId, t);
      } catch {
        /* 坏文件跳过 */
      }
    }
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** 全部任务(供编排器找排队任务)。 */
  values(): IterableIterator<Task> {
    return this.tasks.values();
  }

  create(input: { mode: 'create' | 'modify'; spec: string; context?: TaskContext; sessionId?: string }): Task {
    const taskId = `t_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const task: Task = {
      taskId,
      mode: input.mode,
      spec: input.spec,
      status: 'queued',
      phase: '排队中',
      context: input.context,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(taskId, task);
    this.persist(task);
    this.emitFrame(task, undefined);
    return task;
  }

  /** 状态迁移(带持久化与帧广播)。 */
  transition(taskId: string, status: TaskStatus, extra?: Partial<Task> & { artifact?: { file: string; bytes: number } }): Task {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`任务不存在: ${taskId}`);
    t.status = status;
    t.updatedAt = Date.now();
    if (extra) {
      const { artifact, ...rest } = extra;
      Object.assign(t, rest);
      this.emitFrame(t, artifact);
    } else {
      this.emitFrame(t, undefined);
    }
    this.persist(t);
    return t;
  }

  private persist(t: Task): void {
    mkdirSync(taskDir(t.taskId), { recursive: true });
    writeFileSync(taskFile(t.taskId), JSON.stringify(t, null, 2), 'utf8');
  }

  private emitFrame(t: Task, artifact?: { file: string; bytes: number }): void {
    this.emit({
      type: 'task.frame',
      data: {
        taskId: t.taskId,
        status: t.status,
        phase: t.phase,
        summary: t.summary,
        error: t.error,
        appId: t.appId,
        appUrl: t.appUrl,
        ...(artifact ? { artifact } : {}),
      },
    });
  }

  /** 转发任意帧(非状态迁移帧,如 F3 的 task.stream)。 */
  emitRaw(frame: { type: string; data: Record<string, unknown> }): void {
    this.emit(frame);
  }

  /** 更新附件元信息(F1,附件处理完成后刷新 textPath 等)。 */
  setAttachments(taskId: string, list: TaskAttachment[]): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.attachments = list;
    this.persist(t);
    this.emitFrame(t, undefined);
  }

  /** 读 Agent 落盘产物(ir.json / workflow.yaml / result.json / graph.json)。 */
  readArtifact(taskId: string, file: string): Buffer | null {
    if (!ARTIFACT_WHITELIST.has(file)) return null;
    const f = join(taskDir(taskId), basename(file));
    try {
      return readFileSync(f);
    } catch {
      return null;
    }
  }

  /** 读 result.json(Agent 契约:{status:"draft-ready"|"ready"|"failed", summary, warnings[]})。 */
  readResult(taskId: string): { status?: string; summary?: string; warnings?: string[] } | null {
    const buf = this.readArtifact(taskId, 'result.json');
    if (!buf) return null;
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  }
}
