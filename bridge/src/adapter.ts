/**
 * adapter JSON 通道:从 skills/dify-workflow-dsl/adapter/ 加载版本化 adapter。
 * adapter 是全系统「Dify 版本敏感细节」的唯一机器可读来源(见 DESIGN §5.4)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './config.js';

export interface AdapterInfo {
  version: string;
  difyVersion: string;
  dslVersion: string;
  path: string;
}

const ADAPTER_DIR = join(WORKSPACE_ROOT, 'skills', 'dify-workflow-dsl', 'adapter');

/** 列出 adapter 目录下全部 `dify-<ver>.json`(形如 dify-1.16.1.json)。 */
export function listAdapters(): AdapterInfo[] {
  let files: string[] = [];
  try {
    files = readdirSync(ADAPTER_DIR);
  } catch {
    return [];
  }
  const infos: AdapterInfo[] = [];
  for (const f of files) {
    const m = /^dify-([\d.]+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const raw = JSON.parse(readFileSync(join(ADAPTER_DIR, f), 'utf8')) as Record<string, unknown>;
      infos.push({
        version: m[1]!,
        difyVersion: String(raw['difyVersion'] ?? m[1]),
        dslVersion: String(raw['dslVersion'] ?? '?'),
        path: join(ADAPTER_DIR, f),
      });
    } catch {
      // 坏文件跳过,不影响其他 adapter
    }
  }
  return infos.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

/** 读取某个版本的 adapter JSON;不存在返回 null。 */
export function getAdapter(version: string): Record<string, unknown> | null {
  const safe = version.replace(/[^\d.]/g, '');
  try {
    return JSON.parse(readFileSync(join(ADAPTER_DIR, `dify-${safe}.json`), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
