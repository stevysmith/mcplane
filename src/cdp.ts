/**
 * Just enough of the Chrome DevTools Protocol to drive an Electron app: one
 * WebSocket, requests matched by id, events by name.
 *
 * The WebSocket is a few lines of RFC 6455 over node:http's upgrade rather than
 * Node's built-in one: ChatGPT doesn't always answer a close frame, and the
 * built-in client then holds the process open with no way to drop the socket.
 * It also keeps mcplane on Node 20.
 */
import { createHash, randomBytes } from 'node:crypto';
import { get, request } from 'node:http';
import type { Socket } from 'node:net';

export interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** The debugging port's target list. Plain http with no keep-alive, so nothing holds the process open afterwards. */
export function listTargets(port: number, timeoutMs = 2_000): Promise<Target[]> {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path: '/json/list', agent: false, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`DevTools port ${port} answered HTTP ${res.statusCode}`);
          resolve(JSON.parse(body) as Target[]);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`DevTools port ${port} didn't answer`)));
    req.on('error', reject);
  });
}

/**
 * The app's main window: the page target at exactly `url` (ChatGPT desktop: app://-/index.html).
 * Its other windows (app://-/index.html?initialRoute=…), MCP App iframes, webviews and
 * workers are separate targets and never match.
 */
export function pickMainWindow(targets: Target[], url: string): Target | undefined {
  return targets.find((t) => t.type === 'page' && t.url === url && t.webSocketDebuggerUrl);
}

/* ---------------- WebSocket frames (RFC 6455) ---------------- */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** One client-to-server frame: final, masked as the RFC requires of clients. */
export function encodeFrame(payload: Buffer, opcode: number = OP.text, mask: Buffer = randomBytes(4)): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65_536 ? 4 : 10;
  const out = Buffer.alloc(head + 4 + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = 0x80 | len;
  else if (len < 65_536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  mask.copy(out, head);
  for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Takes every complete frame off the front of `buf`; `rest` is the partial frame still arriving. */
export function decodeFrames(buf: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) {
      if (buf.length - pos < 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    let mask: Buffer | null = null;
    if (b1 & 0x80) {
      if (buf.length - pos < 4) break;
      mask = buf.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buf.length - pos < len) break;
    let payload = buf.subarray(pos, pos + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = pos + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/* ---------------- CDP session ---------------- */

type Pending = { method: string; resolve: (v: any) => void; reject: (e: Error) => void };

export class Cdp {
  private next = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: any) => void>>();
  private closed = false;
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];

  private constructor(private socket: Socket, head: Buffer) {
    socket.setNoDelay(true);
    socket.on('data', (d: Buffer) => this.data(d));
    socket.on('error', () => null); // "close" follows
    socket.on('close', () => this.ended('The DevTools connection closed (did ChatGPT quit?)'));
    if (head.length) this.data(head);
  }

  /** Opens a DevTools WebSocket URL (ws://127.0.0.1:<port>/devtools/page/<id>). */
  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    const u = new URL(url);
    const key = randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      const req = request({
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        agent: false,
        timeout: timeoutMs,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
      });
      req.on('upgrade', (res, socket: Socket, head: Buffer) => {
        socket.setTimeout(0);
        if (res.headers['sec-websocket-accept'] !== createHash('sha1').update(key + GUID).digest('base64')) {
          socket.destroy();
          reject(new Error(`${url} isn't a WebSocket endpoint`));
          return;
        }
        resolve(new Cdp(socket, head));
      });
      req.on('response', (res) => {
        res.resume();
        reject(new Error(`DevTools refused the connection (HTTP ${res.statusCode})`));
      });
      req.on('timeout', () => req.destroy(new Error(`Couldn't connect to ${url}`)));
      req.on('error', reject);
      req.end();
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The DevTools connection is closed'));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(encodeFrame(Buffer.from(JSON.stringify({ id, method, params }))));
    });
  }

  /** Runs an expression in the page and returns its JSON value. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`Page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value as T;
  }

  /** Subscribes to an event; returns the unsubscribe function. */
  on(event: string, fn: (params: any) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return () => set.delete(fn);
  }

  /** Sends a close frame and drops the socket without waiting for an answer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end(encodeFrame(Buffer.alloc(0), OP.close), () => this.socket.destroy());
    this.ended('The DevTools connection is closed');
  }

  private ended(why: string): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
  }

  private data(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const { frames, rest } = decodeFrames(this.buf);
    this.buf = rest;
    for (const f of frames) {
      if (f.opcode === OP.ping) {
        if (!this.closed) this.socket.write(encodeFrame(f.payload, OP.pong));
      } else if (f.opcode === OP.close) {
        this.close();
      } else if (f.opcode === OP.text || f.opcode === OP.binary || f.opcode === OP.continuation) {
        this.parts.push(f.payload);
        if (f.fin) {
          const message = Buffer.concat(this.parts).toString('utf8');
          this.parts = [];
          this.receive(message);
        }
      }
    }
  }

  private receive(raw: string): void {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
      return;
    }
    if (m.method) for (const fn of this.listeners.get(m.method) ?? []) fn(m.params);
  }
}
