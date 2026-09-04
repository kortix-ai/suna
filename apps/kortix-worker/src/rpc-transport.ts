/**
 * The transport under the ExecutionEnv — and the subject of the RPC-tax gate.
 *
 * Every tool call the agent makes crosses this boundary. `bash` is a local
 * fork today, roughly a millisecond. Measured on Daytona, per-call `fetch`
 * costs ~67 ms, which at 200 tool calls is +13 s on EVERY turn, forever —
 * larger than the one-off boot saving the whole split is justified by.
 *
 * Three implementations, so the gate compares like with like:
 *
 *   fetch      one `fetch` per call. What the spike shipped. Whatever pooling
 *              the runtime does, we do not control it.
 *   keepalive  `http.request` over one explicitly-pooled agent: a single TCP
 *              connection, handshake paid once.
 *   ws         one WebSocket, request/response multiplexed by id. No HTTP
 *              framing per call, and the server can push.
 */
import { Agent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
// `ws` loads lazily: only the ws transport needs it, and keeping the top
// level free of it lets other packages import these sources for tests.
interface WsInstance {
  on(event: 'open', listener: () => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  send(data: string): void;
  close(): void;
}

interface WsConstructor {
  new (url: string, options: { headers: Record<string, string> }): WsInstance;
}

export interface RpcTransport {
  call(op: string, args: Record<string, unknown>, cwd: string): Promise<any>;
  close(): Promise<void>;
  readonly kind: string;
}

export class FetchTransport implements RpcTransport {
  readonly kind = 'fetch';
  constructor(private readonly baseUrl: string, private readonly headers: Record<string, string> = {}) {}
  async call(op: string, args: Record<string, unknown>, cwd: string) {
    const res = await fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ op, args, cwd }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async close() {}
}

/** One pooled connection. The handshake is paid once per session, not per call. */
export class KeepAliveTransport implements RpcTransport {
  readonly kind = 'keepalive';
  private readonly agent: Agent | HttpsAgent;
  private readonly url: URL;
  constructor(baseUrl: string, private readonly headers: Record<string, string> = {}) {
    this.url = new URL(`${baseUrl.replace(/\/$/, '')}/rpc`);
    const opts = { keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 };
    this.agent = this.url.protocol === 'https:' ? new HttpsAgent(opts) : new Agent(opts);
  }
  call(op: string, args: Record<string, unknown>, cwd: string): Promise<any> {
    const payload = JSON.stringify({ op, args, cwd });
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port || (this.url.protocol === 'https:' ? 443 : 80),
          path: this.url.pathname,
          method: 'POST',
          agent: this.agent as any,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...this.headers },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }
  async close() { (this.agent as any).destroy?.(); }
}

/** One socket, many in-flight calls, correlated by id. */
export class WebSocketTransport implements RpcTransport {
  readonly kind = 'ws';
  private ws?: WsInstance;
  private ready?: Promise<void>;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  constructor(private readonly baseUrl: string, private readonly headers: Record<string, string> = {}) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const wsModuleName: string = 'ws';
      const { default: WebSocket } = (await import(wsModuleName)) as { default: WsConstructor };
      await new Promise<void>((resolve, reject) => {
        const url = this.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/rpc-ws';
        const ws = new WebSocket(url, { headers: this.headers });
        this.ws = ws;
        ws.on('open', () => resolve());
        ws.on('error', (e) => reject(e));
        ws.on('message', (data) => {
          let msg: any;
          try { msg = JSON.parse(String(data)); } catch { return; }
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          p.resolve(msg.body);
        });
        ws.on('close', () => {
          for (const [, p] of this.pending) p.reject(new Error('rpc socket closed'));
          this.pending.clear();
          this.ready = undefined;
        });
      });
    })();
    return this.ready;
  }

  async call(op: string, args: Record<string, unknown>, cwd: string): Promise<any> {
    await this.connect();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, op, args, cwd }));
    });
  }

  async close() {
    this.ws?.close();
    this.ready = undefined;
  }
}

/**
 * Prefer the multiplexed socket; fall back once, permanently, if it is absent.
 *
 * Daemons are IMAGE-BAKED. A sandbox created before `/rpc-ws` existed will
 * never serve it, so the worker cannot assume the endpoint — but it also must
 * not pay a failed connect on every tool call. One probe per session: if the
 * socket answers, it is used for the rest of the session; if it does not, the
 * fallback is used for the rest of the session.
 *
 * A failure AFTER the socket has served a call is a REAL failure — a dropped
 * connection — and is rethrown so the caller's own retry can reconnect.
 * Quietly switching to HTTP there would hide a broken environment behind a
 * slower one.
 */
export class NegotiatingTransport implements RpcTransport {
  readonly kind = 'auto';
  private proven = false;
  private fellBack = false;

  constructor(
    private readonly preferred: RpcTransport,
    private readonly fallback: RpcTransport,
  ) {}

  async call(op: string, args: Record<string, unknown>, cwd: string): Promise<any> {
    if (this.fellBack) return this.fallback.call(op, args, cwd);
    try {
      const result = await this.preferred.call(op, args, cwd);
      this.proven = true;
      return result;
    } catch (e) {
      if (this.proven) throw e;
      this.fellBack = true;
      try {
        await this.preferred.close();
      } catch {
        // nothing to release
      }
      return this.fallback.call(op, args, cwd);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.preferred.close(), this.fallback.close()]);
  }
}

export function makeTransport(kind: string, baseUrl: string, headers: Record<string, string> = {}): RpcTransport {
  switch (kind) {
    case 'ws': return new WebSocketTransport(baseUrl, headers);
    case 'fetch': return new FetchTransport(baseUrl, headers);
    case 'keepalive': return new KeepAliveTransport(baseUrl, headers);
    // Default: try the socket, fall back to pooled keep-alive. See
    // NegotiatingTransport for why this cannot simply be 'ws'.
    default:
      return new NegotiatingTransport(
        new WebSocketTransport(baseUrl, headers),
        new KeepAliveTransport(baseUrl, headers),
      );
  }
}
