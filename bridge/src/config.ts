/**
 * Indify Bridge 配置:.indifyrc.yaml 的读取与生成。
 * 为避免额外依赖,内置一个只支持「缩进映射 + 标量/列表」的微型 YAML 解析器,
 * 仅用于本项目自产的自描述配置文件(模板由本文件生成,格式可控)。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface BridgeConfig {
  port: number;
  token: string;
  workspaceRoot: string;
  dsh: { baseUrl: string; apiPath: string; eventsMuxPath: string };
  dify: { consoleUrl: string; apiPrefix: string; fixedVersion?: string };
}

/** 工作区根 = 含 DESIGN.md 的最近祖先目录(Bridge 可位于 <root>/bridge 或任意子目录运行)。 */
function findWorkspaceRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'DESIGN.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

export const WORKSPACE_ROOT = findWorkspaceRoot();
export const RC_PATH = join(WORKSPACE_ROOT, '.indifyrc.yaml');

const DEFAULTS: BridgeConfig = {
  port: 39181,
  token: randomBytes(24).toString('hex'),
  workspaceRoot: WORKSPACE_ROOT,
  dsh: {
    baseUrl: 'http://127.0.0.1:3080',
    apiPath: '/api',
    eventsMuxPath: '/api/events.mux',
  },
  dify: { consoleUrl: 'http://localhost', apiPrefix: '/console/api' },
};

/* ---------- 微型 YAML 解析(仅本项目模板格式) ---------- */

interface YNode {
  [key: string]: unknown;
}

function parseMiniYaml(text: string): YNode {
  const root: YNode = {};
  const stack: { indent: number; node: YNode }[] = [{ indent: -1, node: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    const colonIdx = content.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = content.slice(0, colonIdx).trim();
    const rawVal = content.slice(colonIdx + 1).trim();
    // 去掉行内注释
    const hashIdx = rawVal.search(/\s#/);
    const value = (hashIdx >= 0 ? rawVal.slice(0, hashIdx) : rawVal).trim();

    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;

    if (value === '') {
      const child: YNode = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else if (value.startsWith('[') && value.endsWith(']')) {
      parent[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0);
    } else if (/^-?\d+$/.test(value)) {
      parent[key] = Number(value);
    } else if (value === 'true' || value === 'false') {
      parent[key] = value === 'true';
    } else {
      parent[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return root;
}

function buildTemplate(): string {
  return [
    '# Indify Bridge 配置(自动生成,勿入库;改端口需同步扩展配置)',
    `port: ${DEFAULTS.port}`,
    `token: ${DEFAULTS.token}`,
    `workspaceRoot: ${DEFAULTS.workspaceRoot.replace(/\\/g, '/')}`,
    'dsh:',
    `  baseUrl: ${DEFAULTS.dsh.baseUrl}`,
    `  apiPath: ${DEFAULTS.dsh.apiPath}`,
    `  eventsMuxPath: ${DEFAULTS.dsh.eventsMuxPath}`,
    'dify:',
    `  consoleUrl: ${DEFAULTS.dify.consoleUrl}`,
    `  apiPrefix: ${DEFAULTS.dify.apiPrefix}`,
    '  # fixedVersion: ""   # 可固定 Dify 版本号(与 adapter 文件名中的版本一致),留空则运行时探测',
    '',
  ].join('\n');
}

function coerce(raw: YNode): BridgeConfig {
  const pick = (obj: Record<string, unknown>, key: string, def: unknown): unknown =>
    obj[key] === undefined || obj[key] === null ? def : obj[key];
  const dshRaw = (raw['dsh'] as YNode | undefined) ?? {};
  const difyRaw = (raw['dify'] as YNode | undefined) ?? {};
  return {
    port: pick(raw, 'port', DEFAULTS.port) as number,
    token: pick(raw, 'token', DEFAULTS.token) as string,
    workspaceRoot: pick(raw, 'workspaceRoot', WORKSPACE_ROOT) as string,
    dsh: {
      baseUrl: pick(dshRaw, 'baseUrl', DEFAULTS.dsh.baseUrl) as string,
      apiPath: pick(dshRaw, 'apiPath', DEFAULTS.dsh.apiPath) as string,
      eventsMuxPath: pick(dshRaw, 'eventsMuxPath', DEFAULTS.dsh.eventsMuxPath) as string,
    },
    dify: {
      consoleUrl: pick(difyRaw, 'consoleUrl', DEFAULTS.dify.consoleUrl) as string,
      apiPrefix: pick(difyRaw, 'apiPrefix', DEFAULTS.dify.apiPrefix) as string,
      fixedVersion: difyRaw['fixedVersion'] as string | undefined,
    },
  };
}

export function loadConfig(): BridgeConfig {
  if (!existsSync(RC_PATH)) {
    writeFileSync(RC_PATH, buildTemplate(), 'utf8');
    console.log(`[bridge] 已生成 ${RC_PATH}(含随机 token,请勿提交到 git)`);
    return DEFAULTS;
  }
  const raw = parseMiniYaml(readFileSync(RC_PATH, 'utf8'));
  const cfg = coerce(raw);
  // 防御:文件存在但 token 缺失(损坏/旧模板)
  if (!cfg.token || cfg.token.length < 16) {
    cfg.token = randomBytes(24).toString('hex');
    console.warn('[bridge] .indifyrc.yaml 的 token 缺失或过短,本次运行使用临时 token(未回写文件)');
  }
  return cfg;
}
