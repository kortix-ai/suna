/**
 * Graceful shutdown for the HTTP server.
 *
 * ECS gives a stopping task `stop_timeout` seconds (120 s, infra/terraform/
 * modules/ecs-api/variables.tf) and the ALB keeps a deregistering target for
 * `deregistration_delay` (120 s) so streaming requests can finish. This module
 * counts the work that needs those seconds and waits for it:
 *
 *   - every HTTP request, until its response body is fully sent (a streamed
 *     body counts until the stream ends);
 *   - every detached promise registered with `trackDetached` (webhook handlers
 *     that answer 200 first and work afterwards).
 *
 * Long-lived session event streams (`/sessions/:id/events`) never end by
 * themselves. At drain they get `retry: 1000` and a clean end, so the client
 * reconnects to another task with `Last-Event-ID`. WebSockets are not counted;
 * `server.stop(true)` closes them last.
 */

const encoder = new TextEncoder();
const RECONNECT_HINT = encoder.encode('retry: 1000\n\n');

let inflight = 0;
let draining = false;
// replica-local: it counts this process's own work, and each task drains itself on its own SIGTERM.
const idleWaiters = new Set<() => void>();
// replica-local: the streams this process serves.
const closers = new Set<() => void>();

function settle(): void {
  if (inflight === 0) for (const wake of [...idleWaiters]) wake();
}

/** Count one unit of work. Returns the idempotent function that ends it. */
export function beginWork(): () => void {
  inflight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inflight -= 1;
    settle();
  };
}

/** Keep the process alive for a detached promise until it settles. Never rejects. */
export function trackDetached(work: Promise<unknown>): void {
  const end = beginWork();
  void work.then(end, end);
}

export function inflightCount(): number {
  return inflight;
}

export function isDraining(): boolean {
  return draining;
}

/** Streams that outlive any request budget: they are ended at drain, not awaited. */
export function isLongLivedStream(url: string, headers: Headers): boolean {
  return (
    (headers.get('content-type') ?? '').startsWith('text/event-stream') &&
    /\/sessions\/[^/?]+\/events\/?(?:\?|$)/.test(url)
  );
}

// Only bodies that stay open for a long time are wrapped. A wrapped body is a copy
// through a pull stream, which is not worth its cost for a bulk download.
const STREAMING_TYPES = ['text/event-stream', 'application/x-ndjson'];

function isStreamed(headers: Headers): boolean {
  const type = headers.get('content-type') ?? '';
  return STREAMING_TYPES.some((prefix) => type.startsWith(prefix));
}

/**
 * Finish the work unit of one request. A buffered response ends it now. A
 * streamed response ends it when its body ends, is cancelled, or fails.
 */
export function finishRequest(url: string, response: Response | undefined, end: () => void): Response | undefined {
  if (!response?.body || !isStreamed(response.headers)) {
    end();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const finish = () => {
    if (closed) return;
    closed = true;
    closers.delete(closer);
    end();
  };
  // Ends the stream with a reconnect hint; the upstream is cancelled behind it.
  const closer = () => {
    if (closed) return;
    try {
      streamController?.enqueue(RECONNECT_HINT);
      streamController?.close();
    } catch {
      // the client already hung up
    }
    finish();
    void reader.cancel().catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        if (!isLongLivedStream(url, response.headers)) return;
        if (draining) closer();
        else closers.add(closer);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (closed) return;
          if (done) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          if (closed) return;
          finish();
          controller.error(error);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function waitForIdle(budgetMs: number): Promise<boolean> {
  if (inflight === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      idleWaiters.delete(wake);
      resolve(false);
    }, budgetMs);
    const wake = () => {
      clearTimeout(timer);
      idleWaiters.delete(wake);
      resolve(true);
    };
    idleWaiters.add(wake);
  });
}

interface StoppableServer {
  stop(force?: boolean): unknown;
}

/** The server instance Bun hands to `fetch`; captured so shutdown can stop it. */
let server: StoppableServer | null = null;
export function captureServer(candidate: unknown): void {
  const maybe = candidate as StoppableServer | null | undefined;
  if (maybe && typeof maybe.stop === 'function') server = maybe;
}

export interface DrainResult {
  /** Work units still running when the budget ended. */
  remaining: number;
}

/**
 * 1. Wait `propagationMs` with the listener open: the ALB may still send a few
 *    requests until its deregistration reaches every node.
 * 2. End long-lived streams with a reconnect hint; refuse to start new ones.
 * 3. Stop accepting connections (in-flight requests continue).
 * 4. Wait up to `budgetMs` for in-flight work.
 * 5. Close what remains, WebSockets included.
 */
export async function drainRequests(options: { propagationMs: number; budgetMs: number }): Promise<DrainResult> {
  draining = true;
  await new Promise((resolve) => setTimeout(resolve, options.propagationMs));
  for (const close of [...closers]) close();
  void Promise.resolve(server?.stop()).catch(() => {});
  await waitForIdle(options.budgetMs);
  const remaining = inflight;
  void Promise.resolve(server?.stop(true)).catch(() => {});
  return { remaining };
}

/** Test seam: reset module state. */
export function resetDrainForTests(): void {
  inflight = 0;
  draining = false;
  idleWaiters.clear();
  closers.clear();
  server = null;
}
