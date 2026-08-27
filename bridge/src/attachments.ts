/**
 * 附件处理(F1):白名单/上限校验 → 落盘 generated/{taskId}/attachments/ → 提取文本 → OCR。
 *
 * 能力矩阵(用户拍板,仅 OCR 文本通道,无多模态):
 *   PDF(文字层)  → pdfjs 抽文本 → <name>.txt
 *   PDF(扫描版)  → pdfjs 渲染页图(≤30 页)→ RapidOCR 逐页识别 → <name>.ocr.txt
 *   图片         → RapidOCR 识别 → <name>.ocr.txt(面板标注「OCR 文本,可能有误」)
 *   文本类       → 原样落盘,Agent 直接读
 *   其它/音视频  → 白名单拒绝
 *
 * OCR 运行在专用 venv(.venv-ocr,见 tools/setup-ocr.ps1/.sh),不阻塞任务:
 * 处理在任务排队/建会话期间后台跑,编排器在发计划 prompt 前等待(≤180s);
 * 仍超时则以「识别中」状态写入提示词,完成后经 task.stream 通知。
 *
 * pdfjs-dist 在 Node 下自动使用 fake worker 并自动加载 @napi-rs/canvas(4.x 内建逻辑),无需 workerSrc。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { WORKSPACE_ROOT } from './config.js';
import type { TaskAttachment } from './tasks.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

export interface IncomingAttachment {
  name: string;
  mimeType?: string;
  size?: number;
  dataBase64: string;
}

export const LIMITS = {
  pdfBytes: 20 * 1024 * 1024,
  imageBytes: 5 * 1024 * 1024,
  textBytes: 5 * 1024 * 1024,
  maxImages: 20, // 张/任务
  maxOcrPages: 30, // 扫描版 PDF 的 OCR 页数上限(其余页保留页图)
  pdfMinTextChars: 40, // 低于此字数判定为扫描版
};

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const TEXT_EXTS = ['.txt', '.md', '.csv', '.json', '.yaml', '.yml'];
const PDF_EXT = '.pdf';

export type AttachmentKind = 'pdf' | 'image' | 'text';

export function classify(name: string, mimeType?: string): { kind?: AttachmentKind; error?: string } {
  const ext = extname(name).toLowerCase();
  const mime = (mimeType ?? '').toLowerCase();
  if (ext === PDF_EXT) {
    if (mime && mime !== 'application/pdf') return { error: `「${name}」扩展名与 MIME 不符(${mimeType}),已拒绝` };
    return { kind: 'pdf' };
  }
  if (IMAGE_EXTS.includes(ext)) {
    if (mime && !mime.startsWith('image/')) return { error: `「${name}」扩展名与 MIME 不符(${mimeType}),已拒绝` };
    return { kind: 'image' };
  }
  if (TEXT_EXTS.includes(ext)) {
    if (mime && !(mime.startsWith('text/') || mime === 'application/json')) {
      return { error: `「${name}」扩展名与 MIME 不符(${mimeType}),已拒绝` };
    }
    return { kind: 'text' };
  }
  return { error: `「${name}」类型暂不支持(仅 PDF/图片/文本;音视频与 docx 等请转为 PDF 或文本)` };
}

function b64Bytes(b64: string): number {
  const clean = b64.replace(/\s/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - pad;
}

export interface ValidatedAttachment {
  name: string;
  kind: AttachmentKind;
  mimeType?: string;
  bytes: number;
  data: Buffer;
}

/** Bridge 侧权威校验(白名单 + MIME 双查 + 大小上限 + 图片张数)。 */
export function validateAttachments(
  items: IncomingAttachment[],
  existingImages = 0,
): { ok: true; validated: ValidatedAttachment[] } | { ok: false; error: string } {
  const out: ValidatedAttachment[] = [];
  let images = existingImages;
  for (const item of items) {
    const name = sanitizeName(item.name);
    if (!name) return { ok: false, error: '附件文件名非法(为空或含路径)' };
    const c = classify(name, item.mimeType);
    if (c.error) return { ok: false, error: c.error };
    const kind = c.kind!;
    let data: Buffer;
    try {
      data = Buffer.from(item.dataBase64 ?? '', 'base64');
    } catch {
      return { ok: false, error: `「${name}」base64 解码失败` };
    }
    const bytes = data.length;
    const declared = typeof item.size === 'number' ? item.size : null;
    if (declared !== null && Math.abs(declared - bytes) > Math.max(64, declared * 0.05)) {
      return { ok: false, error: `「${name}」大小与内容不符(声明 ${declared}B,实际 ${bytes}B),已拒绝` };
    }
    const cap = kind === 'pdf' ? LIMITS.pdfBytes : kind === 'image' ? LIMITS.imageBytes : LIMITS.textBytes;
    if (bytes > cap) {
      return { ok: false, error: `「${name}」超出大小上限(${Math.round(cap / 1024 / 1024)}MB/个),已拒绝` };
    }
    if (kind === 'image') {
      images += 1;
      if (images > LIMITS.maxImages) {
        return { ok: false, error: `图片数量超过上限(≤${LIMITS.maxImages} 张/任务),已拒绝` };
      }
    }
    out.push({ name, kind, mimeType: item.mimeType, bytes, data });
  }
  return { ok: true, validated: out };
}

/** 文件名消毒:只保留基础名,替换危险字符。 */
export function sanitizeName(name: string): string {
  const base = basename(String(name ?? '').replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return '';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 128);
  return cleaned.startsWith('.') ? `_${cleaned}` : cleaned;
}

export function attachmentsDir(taskId: string): string {
  return join(WORKSPACE_ROOT, 'generated', taskId, 'attachments');
}

function uniquePath(dir: string, name: string): string {
  const base = name.replace(/(\.[^.]+)$/, '');
  const ext = extname(name);
  let p = join(dir, name);
  let i = 2;
  while (existsSync(p)) {
    p = join(dir, `${base}_${i}${ext}`);
    i += 1;
  }
  return p;
}

/** 落盘附件原件,返回任务元信息(path/textPath 均相对 attachments 目录)。 */
export function saveAttachments(taskId: string, validated: ValidatedAttachment[]): TaskAttachment[] {
  const dir = attachmentsDir(taskId);
  mkdirSync(dir, { recursive: true });
  const out: TaskAttachment[] = [];
  for (const v of validated) {
    const path = uniquePath(dir, v.name);
    writeFileSync(path, v.data);
    out.push({ name: v.name, kind: v.kind, path: basename(path) });
  }
  return out;
}

/* ---------- OCR(专用 venv) ---------- */

function venvPython(): string | null {
  const win = join(WORKSPACE_ROOT, '.venv-ocr', 'Scripts', 'python.exe');
  const posix = join(WORKSPACE_ROOT, '.venv-ocr', 'bin', 'python');
  if (existsSync(win)) return win;
  if (existsSync(posix)) return posix;
  return null;
}

export function ocrAvailable(): boolean {
  return venvPython() !== null;
}

function runOcr(images: string[], outDir: string, pagePrefix?: string): Promise<{ lines: Record<string, unknown>[]; ok: boolean }> {
  return new Promise((resolve) => {
    const python = venvPython();
    if (!python) {
      resolve({ ok: false, lines: [{ error: 'OCR 环境未安装(.venv-ocr)' }] });
      return;
    }
    const args = [join(WORKSPACE_ROOT, 'tools', 'ocr.py'), ...images, '--out-dir', outDir];
    if (pagePrefix) args.push('--page-prefix', pagePrefix);
    const child = spawn(python, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, // 双保险:子进程 stdout 强制 UTF-8
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ ok: false, lines: [{ error: `OCR 进程启动失败: ${e.message}` }] }));
    child.on('close', (code) => {
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return { error: l.slice(0, 200) };
          }
        });
      if (code !== 0) lines.push({ error: `OCR 退出码 ${code}: ${stderr.slice(0, 300)}` });
      resolve({ ok: code === 0, lines });
    });
  });
}

/* ---------- PDF(pdfjs-dist,Node 自动 fake worker + @napi-rs/canvas) ---------- */

async function extractPdfText(data: Buffer): Promise<{ text: string; pageCount: number }> {
  const doc = await getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const pageText = tc.items
      .map((it: { str?: unknown }) => ('str' in it ? String(it.str) : ''))
      .join('\n');
    parts.push(`===== PAGE ${i} =====\n${pageText}`);
    page.cleanup();
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { text: parts.join('\n\n'), pageCount };
}

async function renderPdfPages(data: Buffer, dir: string, stem: string, maxPages: number): Promise<{ pages: string[]; skipped: number; error?: string }> {
  const doc = await getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const total = doc.numPages;
  const count = Math.min(total, maxPages);
  const pages: string[] = [];
  try {
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(1, Math.min(2, 2400 / base.width));
      const viewport = page.getViewport({ scale });
      // pdfjs 4.x 要求 render() 自带 canvasContext(Node 下 canvas 由 @napi-rs/canvas 提供)
      const canvas = createCanvas(viewport.width, viewport.height) as unknown as {
        getContext: (kind: '2d') => unknown;
        toBuffer: (mime: string) => Buffer;
      };
      const canvasContext = canvas.getContext('2d');
      const canvasFactory = {
        create(width: number, height: number) {
          return createCanvas(width, height) as unknown as { getContext: (kind: '2d') => unknown; toBuffer: (mime: string) => Buffer };
        },
        reset(canvasAndContext: unknown, width: number, height: number) {
          const cc = canvasAndContext as { canvas: { width: number; height: number } };
          cc.canvas.width = width;
          cc.canvas.height = height;
        },
        destroy(canvasAndContext: unknown) {
          const cc = canvasAndContext as { canvas: { width: number; height: number }; context: unknown };
          cc.canvas.width = 0;
          cc.canvas.height = 0;
          cc.context = null;
        },
      };
      await page.render({ canvasContext, canvasFactory, viewport }).promise;
      const pngPath = join(dir, `${stem}.page-${String(i).padStart(3, '0')}.png`);
      writeFileSync(pngPath, canvas.toBuffer('image/png'));
      pages.push(pngPath);
      page.cleanup();
    }
    await doc.destroy();
    return { pages, skipped: total - count };
  } catch (e) {
    try {
      await doc.destroy();
    } catch {
      /* 忽略 */
    }
    return { pages, skipped: total - count, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------- 处理器 ---------- */

export interface ProcessorNote {
  note: string;
  kind?: string;
}

export type NoteEmitter = (taskId: string, note: string) => void;

interface ProcState {
  status: 'running' | 'done' | 'error';
  note?: string;
  attachments: TaskAttachment[];
}

export class AttachmentProcessor {
  private states = new Map<string, ProcState>();
  private lists = new Map<string, TaskAttachment[]>(); // 任务累积附件清单(补传批次并入)

  constructor(
    private readonly updateMeta: (taskId: string, list: TaskAttachment[]) => void,
    private readonly emitNote: NoteEmitter,
  ) {}

  statusOf(taskId: string): { status: 'running' | 'done' | 'error' | 'none'; note?: string } {
    const s = this.states.get(taskId);
    return s ? { status: s.status, note: s.note } : { status: 'none' };
  }

  waitProcessed(taskId: string, timeoutMs: number): Promise<void> {
    const s = this.states.get(taskId);
    if (!s || s.status !== 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = setInterval(() => {
        const cur = this.states.get(taskId);
        if (!cur || cur.status !== 'running' || Date.now() > deadline) {
          clearInterval(tick);
          resolve();
        }
      }, 1000);
    });
  }

  /** 后台启动处理(不阻塞);补传批次并入同任务清单,完成后统一更新元信息并经 task.stream 通知。 */
  start(taskId: string, batch: TaskAttachment[]): void {
    const list = this.lists.get(taskId) ?? [];
    list.push(...batch);
    this.lists.set(taskId, list);
    const existing = this.states.get(taskId);
    if (existing && existing.status === 'running') {
      // 正在跑的 run 遍历的是同一个活数组,追加项会被接着处理
      return;
    }
    const state: ProcState = { status: 'running', attachments: list };
    this.states.set(taskId, state);
    void this.run(taskId, state);
  }

  private async run(taskId: string, state: ProcState): Promise<void> {
    const dir = attachmentsDir(taskId);
    mkdirSync(dir, { recursive: true });
    const notes: string[] = [];
    for (const att of state.attachments) {
      try {
        if (att.kind === 'text') {
          continue; // 原样已落盘,无需处理
        }
        if (att.kind === 'image') {
          if (att.textPath) continue; // 已识别过(补传批次不会重复跑)
          if (!ocrAvailable()) {
            notes.push(`OCR 环境未安装:图片「${att.name}」未识别文本(原图保留在 attachments/ 供人工查看)`);
            continue;
          }
          const r = await runOcr([join(dir, att.path)], dir);
          const okLine = r.lines.find((l) => l['ok'] === true && typeof l['out'] === 'string');
          if (okLine) {
            att.textPath = `attachments/${basename(String(okLine['out']))}`;
            notes.push(`附件识别完成:${att.name}(OCR 文本,可能有误)`);
          } else {
            const err = r.lines.map((l) => l['error']).filter(Boolean).join('; ');
            notes.push(`附件「${att.name}」识别失败:${err || '未知错误'}(原图保留供人工查看)`);
          }
          continue;
        }
        // pdf
        if (att.textPath) continue; // 已识别过(补传批次不会重复跑)
        const data = readFileSync(join(dir, att.path));
        let text = '';
        let pageCount = 0;
        try {
          const r = await extractPdfText(data);
          text = r.text;
          pageCount = r.pageCount;
        } catch (e) {
          notes.push(`附件「${att.name}」文本抽取失败(${e instanceof Error ? e.message : e}),按扫描版处理`);
        }
        const plain = text.replace(/\s+/g, '');
        if (plain.length >= LIMITS.pdfMinTextChars) {
          const txtPath = `${att.name}.txt`;
          writeFileSync(join(dir, txtPath), text, 'utf8');
          att.textPath = `attachments/${txtPath}`;
          notes.push(`附件识别完成:${att.name}(文字层抽取,${pageCount} 页)`);
        } else {
          // 扫描版:渲染页图 → OCR
          const stem = att.name.replace(/\.pdf$/i, '');
          const rendered = await renderPdfPages(data, dir, stem, LIMITS.maxOcrPages);
          if (rendered.error) {
            notes.push(`附件「${att.name}」页渲染失败:${rendered.error}(原文件保留供人工查看)`);
            continue;
          }
          if (!ocrAvailable()) {
            notes.push(`OCR 环境未安装:扫描版 PDF「${att.name}」未识别文本(已渲染 ${rendered.pages.length} 页图供人工查看)`);
            continue;
          }
          const r = await runOcr(rendered.pages, dir, `${stem}.`);
          const txtPath = `${att.name}.ocr.txt`;
          const pieces: string[] = [];
          for (const line of r.lines) {
            const out = line['out'];
            if (typeof out === 'string') {
              try {
                pieces.push(readFileSync(out, 'utf8').trim());
              } catch {
                /* 忽略 */
              }
            }
          }
          writeFileSync(join(dir, txtPath), pieces.join('\n\n') + '\n', 'utf8');
          att.textPath = `attachments/${txtPath}`;
          const extra = rendered.skipped > 0 ? `;超过 ${LIMITS.maxOcrPages} 页的部分仅保留页图` : '';
          notes.push(`附件识别完成:${att.name}(扫描版,${rendered.pages.length} 页 OCR,文本可能有误${extra})`);
        }
      } catch (e) {
        notes.push(`附件「${att.name}」处理异常:${e instanceof Error ? e.message : String(e)}`);
      }
    }
    state.status = 'done';
    state.note = notes.join(';');
    this.updateMeta(taskId, state.attachments);
    if (notes.length > 0) this.emitNote(taskId, notes.join(';'));
  }
}
