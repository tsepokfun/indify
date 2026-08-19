/**
 * 健康探测:DSH(127.0.0.1:3080)与 Dify 控制台(http://localhost)的可达性。
 * 只做轻量请求,不带凭据,不触发业务副作用。
 */
import type { BridgeConfig } from './config.js';

export interface Reachability {
  url: string;
  reachable: boolean;
  note: string;
}

async function probe(url: string, timeoutMs: number): Promise<{ status: number; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), method: 'GET' });
    return { status: res.status };
  } catch (e) {
    return { status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function probeDsh(cfg: BridgeConfig): Promise<Reachability> {
  const url = `${cfg.dsh.baseUrl}${cfg.dsh.apiPath}`;
  // GET /api 会被信任墙拦截(403/404/405 都说明服务活着);若 426 说明是 mux 路径要求——总之有响应即可达。
  const r = await probe(url, 3000);
  return { url, reachable: r.status > 0, note: r.status === 0 ? `unreachable: ${r.error ?? ''}` : `http ${r.status}` };
}

export async function probeDify(cfg: BridgeConfig): Promise<Reachability> {
  const url = `${cfg.dify.consoleUrl}${cfg.dify.apiPrefix}/system-features`;
  const r = await probe(url, 3000);
  return { url, reachable: r.status === 200, note: r.status === 0 ? `unreachable: ${r.error ?? ''}` : `http ${r.status}` };
}
