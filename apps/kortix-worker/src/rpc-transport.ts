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
import { randomUUID } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
const RPC_CANCEL_TIMEOUT_MS = 5_000;
// `ws` loads lazily: only the ws transport needs it, and keeping the top
// level free of it lets other packages import these sources for tests.
interface WsInstance {
  on(event: 'open', listener: () => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(
    event: 'unexpected-response',
    listener: (
      request: { destroy?: () => void },
      response: { statusCode?: number; resume?: () => void },
    ) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

interface WsConstructor {
  new (url: string, options: { headers: Record<string, string> }): WsInstance;
}

export interface RpcTransport {
  call(op: string, args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<any>;
  close(): Promise<void>;
  readonly kind: string;
}

export class RpcUnavailableBeforeSendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RpcUnavailableBeforeSendError';
  }
}

export class RpcUnauthorizedBeforeExecutionError extends Error {
  readonly status = 401;

  constructor(message = 'environment RPC returned HTTP 401', options?: ErrorOptions) {
    super(message, options);
    this.name = 'RpcUnauthorizedBeforeExecutionError';
  }
}

export class RpcCancellationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RpcCancellationError';
  }
}

function isUnauthorizedUpgrade(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error);
  return /(?:server response:|HTTP)\s*401\b/i.test(message);
}

function isUnauthorizedBody(body: unknown): body is { error: 'unauthorized'; reason?: unknown } {
  return !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'unauthorized';
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : 'aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function waitForReady(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return ready;
  throwIfAborted(signal);
  let rejectOnAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort(abortError(signal));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([ready, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function cancelRpc(
  baseUrl: string,
  headers: Record<string, string>,
  requestId: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ requestId }),
      signal: AbortSignal.timeout(RPC_CANCEL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RpcCancellationError('environment RPC cancellation request failed', {
      cause: error,
    });
  }
  if (!res.ok) {
    throw new RpcCancellationError(`environment RPC cancellation returned HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    value?: { cancelled?: unknown };
  } | null;
  if (body?.ok !== true || typeof body.value?.cancelled !== 'boolean') {
    throw new RpcCancellationError('environment RPC cancellation was not acknowledged');
  }
}

export async function withCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  cancel: () => Promise<void>,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    await cancel();
    throw abortError(signal);
  }

  let rejectOnAbort!: (error: Error) => void;
  let cancellation: Promise<void> | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => {
    cancellation = cancel();
    void cancellation.catch(() => {});
    rejectOnAbort(abortError(signal));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const value = await Promise.race([operation, aborted]);
    if (signal.aborted) {
      await cancellation;
      throw abortError(signal);
    }
    return value;
  } catch (error) {
    if (signal.aborted) {
      await cancellation;
      throw abortError(signal);
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class FetchTransport implements RpcTransport {
  readonly kind = 'fetch';
  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string> = {},
  ) {}
  async call(op: string, args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const requestId = randomUUID();
    const requestController = new AbortController();
    const response = fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ op, args, cwd, requestId }),
      signal: requestController.signal,
    });
    const res = await withCancellation(response, signal, async () => {
      requestController.abort();
      await cancelRpc(this.baseUrl, this.headers, requestId);
    });
    if (res.status === 401) throw new RpcUnauthorizedBeforeExecutionError();
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
  constructor(
    baseUrl: string,
    private readonly headers: Record<string, string> = {},
  ) {
    this.url = new URL(`${baseUrl.replace(/\/$/, '')}/rpc`);
    const opts = { keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 };
    this.agent = this.url.protocol === 'https:' ? new HttpsAgent(opts) : new Agent(opts);
  }
  call(op: string, args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<any> {
    throwIfAborted(signal);
    const requestId = randomUUID();
    const payload = JSON.stringify({ op, args, cwd, requestId });
    let req: ReturnType<typeof httpRequest> | undefined;
    const response = new Promise<any>((resolve, reject) => {
      req = httpRequest(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port || (this.url.protocol === 'https:' ? 443 : 80),
          path: this.url.pathname,
          method: 'POST',
          agent: this.agent as any,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...this.headers,
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode === 401) {
              reject(new RpcUnauthorizedBeforeExecutionError());
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
    return withCancellation(response, signal, async () => {
      req?.destroy(abortError(signal));
      await cancelRpc(this.url.toString().replace(/\/rpc$/, ''), this.headers, requestId);
    });
  }
  async close() {
    (this.agent as any).destroy?.();
  }
}

/** One socket, many in-flight calls, correlated by id. */
export class WebSocketTransport implements RpcTransport {
  readonly kind = 'ws';
  private ws?: WsInstance;
  private ready?: Promise<void>;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();

  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string> = {},
  ) {}

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
        ws.on('unexpected-response', (request, response) => {
          response.resume?.();
          request.destroy?.();
          if (response.statusCode === 401) {
            reject(new RpcUnauthorizedBeforeExecutionError());
            return;
          }
          reject(new Error(`Unexpected server response: ${response.statusCode ?? 'unknown'}`));
        });
        ws.on('message', (data) => {
          let msg: any;
          try {
            msg = JSON.parse(String(data));
          } catch {
            return;
          }
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

  private sendFrame(frame: Record<string, unknown>): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify({ ...frame, id }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async call(
    op: string,
    args: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<any> {
    throwIfAborted(signal);
    try {
      await waitForReady(this.connect(), signal);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (error instanceof RpcUnauthorizedBeforeExecutionError) throw error;
      if (isUnauthorizedUpgrade(error)) {
        throw new RpcUnauthorizedBeforeExecutionError(undefined, { cause: error });
      }
      throw new RpcUnavailableBeforeSendError(String((error as Error)?.message ?? error), {
        cause: error,
      });
    }
    throwIfAborted(signal);
    const requestId = randomUUID();
    const response = this.sendFrame({ type: 'call', op, args, cwd, requestId });
    const body = await withCancellation(response, signal, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.ws?.close();
          reject(new RpcCancellationError('environment RPC cancellation timed out'));
        }, RPC_CANCEL_TIMEOUT_MS);
        timer.unref?.();
      });
      let body: { ok?: unknown; value?: { cancelled?: unknown } } | null;
      try {
        body = (await Promise.race([this.sendFrame({ type: 'cancel', requestId }), timeout])) as {
          ok?: unknown;
          value?: { cancelled?: unknown };
        } | null;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (body?.ok !== true || typeof body.value?.cancelled !== 'boolean') {
        throw new RpcCancellationError('environment RPC cancellation was not acknowledged');
      }
    });
    if (isUnauthorizedBody(body)) {
      const reason = typeof body.reason === 'string' && body.reason ? `: ${body.reason}` : '';
      throw new RpcUnauthorizedBeforeExecutionError(`environment RPC returned HTTP 401${reason}`);
    }
    return body;
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

  async call(
    op: string,
    args: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.fellBack) return this.fallback.call(op, args, cwd, signal);
    try {
      const result = await this.preferred.call(op, args, cwd, signal);
      this.proven = true;
      return result;
    } catch (e) {
      if (this.proven || !(e instanceof RpcUnavailableBeforeSendError)) throw e;
      this.fellBack = true;
      try {
        await this.preferred.close();
      } catch {
        // nothing to release
      }
      return this.fallback.call(op, args, cwd, signal);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.preferred.close(), this.fallback.close()]);
  }
}

export function makeTransport(
  kind: string,
  baseUrl: string,
  headers: Record<string, string> = {},
): RpcTransport {
  switch (kind) {
    case 'ws':
      return new WebSocketTransport(baseUrl, headers);
    case 'fetch':
      return new FetchTransport(baseUrl, headers);
    case 'keepalive':
      return new KeepAliveTransport(baseUrl, headers);
    // Default: try the socket, fall back to pooled keep-alive. See
    // NegotiatingTransport for why this cannot simply be 'ws'.
    default:
      return new NegotiatingTransport(
        new WebSocketTransport(baseUrl, headers),
        new KeepAliveTransport(baseUrl, headers),
      );
  }
}
