/**
 * Just enough of a streamable-HTTP MCP client to inspect a server the way a
 * store's scanner does: plain POSTs, JSON or SSE replies, a session id if the
 * server hands one out.
 */
export interface RpcReply {
  status: number;
  contentType: string;
  body: any;
  headers: Headers;
}

const UA = 'mcplane (+https://github.com/stevysmith/mcplane)';

export class McpClient {
  private session: string | null = null;
  private id = 0;
  constructor(readonly url: string, private extraHeaders: Record<string, string> = {}, private timeoutMs = 15_000) {}

  async request(method: string, params?: unknown, opts: { notification?: boolean; url?: string } = {}): Promise<RpcReply> {
    const body = opts.notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      'user-agent': UA,
      ...this.extraHeaders,
    };
    if (this.session) headers['mcp-session-id'] = this.session;
    const res = await fetch(opts.url ?? this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    return { status: res.status, contentType, body: parseBody(text, contentType), headers: res.headers };
  }

  async initialize(): Promise<RpcReply> {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcplane', version: '0.1.0' },
    });
    if (r.status < 300) await this.request('notifications/initialized', undefined, { notification: true }).catch(() => null);
    return r;
  }
}

/** JSON, or the last JSON-RPC message in an SSE stream. */
function parseBody(text: string, contentType: string): any {
  if (contentType.includes('text/event-stream')) {
    const datas = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(datas[i]);
      } catch {}
    }
    return null;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
