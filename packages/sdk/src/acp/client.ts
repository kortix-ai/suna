import { authenticatedFetch } from '../core/http/auth';
import type { AcpTranscriptRow } from './transcript';
import type {
  AcpConnectionState,
  AcpContentBlock,
  AcpEnvelope,
  AcpJsonRpcId,
  AcpResponse,
  AcpStreamEvent,
  AcpStreamHandle,
  AcpInitializeResult,
  AcpSessionResult,
  AcpNewSessionResult,
} from './types';
import { AcpRpcError, AcpTransportError } from './types';

/** 4xx except 408 (Request Timeout) and 429 (Too Many Requests), which are
 *  transient-by-convention and should keep retrying with backoff. */
function isTerminalStatus(status: number): boolean {
  return status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

export type AcpClientOptions = {
  /** Exact session-scoped ACP endpoint. Preferred for provider-neutral clients. */
  endpoint?: string;
  /** Direct daemon bridge inputs (low-level/testing compatibility). */
  baseUrl?: string;
  serverId?: string;
  /**
   * Harness/agent identifier for the ACP daemon bridge (`baseUrl` +
   * `serverId` mode only). Per the ACP daemon spec the first POST to a new
   * server must carry `?agent=`; appending it to every POST is simplest and
   * still spec-compliant. Ignored in `endpoint` mode, where the harness is
   * already resolved server-side.
   */
  agent?: string;
  fetch?: typeof fetch;
  /**
   * `auto` uses SSE where streaming response bodies exist and durable
   * transcript polling on React Native. `poll` is also useful for constrained
   * fetch implementations and deterministic tests.
   */
  streamTransport?: 'auto' | 'sse' | 'poll';
  transcriptPollIntervalMs?: number;
};

function isResponse(value: AcpEnvelope): value is AcpResponse {
  return 'id' in value && ('result' in value || 'error' in value) && !('method' in value);
}

export class AcpClient {
  private nextId = 0;
  /**
   * Snapshotted at CONSTRUCTION time (not module load) so every client
   * instance gets its own prefix — a module-level constant would make ids
   * predictable/shared across instances and break tests that need
   * per-instance determinism. Combined with a static instance counter,
   * no two instances ever produce the same id, even if constructed in the
   * exact same millisecond.
   */
  private static instanceCount = 0;
  private readonly idPrefix = `${Date.now()}-${AcpClient.instanceCount++}`;
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;
  /** `?agent=<agent>` appended to POST URLs in `baseUrl`+`serverId` (daemon
   *  bridge) mode only; empty string in `endpoint` mode or when unset. */
  private readonly agentQuery: string;

  constructor(readonly options: AcpClientOptions) {
    this.fetcher = options.fetch ?? (authenticatedFetch as typeof fetch);
    if (options.endpoint) {
      this.endpoint = options.endpoint.replace(/\/$/, '');
      this.agentQuery = '';
    } else if (options.baseUrl && options.serverId) {
      this.endpoint = `${options.baseUrl.replace(/\/$/, '')}/acp/${encodeURIComponent(options.serverId)}`;
      this.agentQuery = options.agent ? `?agent=${encodeURIComponent(options.agent)}` : '';
    } else {
      throw new Error('AcpClient requires endpoint, or baseUrl + serverId');
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `${this.idPrefix}-${++this.nextId}`;
    const envelope = await this.post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    if (!envelope || !isResponse(envelope)) throw new Error(`ACP method ${method} returned no JSON-RPC response`);
    if (envelope.id !== id) {
      throw new Error(`ACP response id mismatch for ${method}: expected ${JSON.stringify(id)}, got ${JSON.stringify(envelope.id)}`);
    }
    if (envelope.error) throw new AcpRpcError(envelope.error.message, envelope.error.code, envelope.error.data);
    return envelope.result as T;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async respond(id: AcpJsonRpcId, result?: unknown, error?: AcpResponse['error']): Promise<void> {
    await this.post({ jsonrpc: '2.0', id, ...(error ? { error } : { result: result ?? null }) });
  }

  initialize(params: {
    protocolVersion: number;
    clientCapabilities?: Record<string, unknown>;
    clientInfo?: { name: string; title?: string; version: string };
  }) {
    return this.request<AcpInitializeResult>('initialize', params);
  }

  newSession(params: { cwd: string; mcpServers?: unknown[] }) {
    return this.request<AcpNewSessionResult>('session/new', {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
  }

  loadSession(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }) {
    return this.request<AcpSessionResult>('session/load', {
      ...params,
      mcpServers: params.mcpServers ?? [],
    });
  }

  setSessionConfigOption(sessionId: string, configId: string, value: unknown) {
    return this.request<AcpSessionResult>('session/set_config_option', { sessionId, configId, value });
  }

  prompt(sessionId: string, prompt: AcpContentBlock[]) {
    return this.request<{ stopReason: string }>('session/prompt', { sessionId, prompt });
  }

  cancel(sessionId: string) {
    return this.notify('session/cancel', { sessionId });
  }

  async transcript(after?: number, signal?: AbortSignal): Promise<{
    runtime_id: string;
    envelopes: AcpTranscriptRow[];
  }> {
    const url = `${this.endpoint}/transcript${after ? `?after=${after}` : ''}`;
    const response = await this.fetcher(url, signal ? { signal } : undefined);
    if (!response.ok) {
      throw new AcpTransportError(
        `ACP transcript failed with HTTP ${response.status}`,
        response.status,
        isTerminalStatus(response.status),
      );
    }
    return response.json();
  }

  connect(options: {
    onEvent(event: AcpStreamEvent): void;
    onError?(error: unknown): void;
    /**
     * Connection-lifecycle transitions: `'connecting'` before each fetch/poll
     * attempt, `'open'` once a response is successfully established (not
     * gated on an actual event arriving — see the `retryMs` reset note
     * below), `'reconnecting'` after a non-terminal error, `'failed'` when a
     * terminal error stops the loop for good, `'closed'` on a clean end or
     * `handle.close()`.
     *
     * `'open'` = the stream response is established (HTTP OK + a readable
     * body), not "an event has arrived" — this mirrors `EventSource.onopen`
     * semantics, and it's deliberate: gating `'open'` on the first event
     * would leave an idle-but-healthy session reporting `'reconnecting'`
     * indefinitely after a silent, successful reconnect. This is a
     * deliberate asymmetry with the `retryMs` reset, which stays gated on
     * the first delivered event — `'open'` is UI truth (the connection is
     * live), the backoff reset is conservative (only relax retry pacing once
     * an attempt has proven it can actually deliver data).
     */
    onState?(state: AcpConnectionState): void;
    lastEventId?: number;
    signal?: AbortSignal;
    reconnect?: boolean;
  }): AcpStreamHandle {
    // `null` = "no event has ever been seen", distinct from the numeric
    // event id `0` (a real, deliverable id — SSE and the transcript ordinal
    // sequence both start at 0). Collapsing these onto a shared `number`
    // defaulting to `0` used to make an `id: 0` event permanently
    // indistinguishable from "already delivered up to 0", so it was silently
    // dropped by the `event.id <= lastEventId` dedupe check below. The
    // public `AcpStreamHandle.lastEventId` getter still returns a plain
    // `number` (its documented contract) via `lastEventId ?? 0`.
    let lastEventId: number | null = options.lastEventId ?? null;

    // An already-aborted signal means the caller never wants this stream to
    // fetch anything — not even once. Check upfront and hand back an
    // already-closed handle without touching `this.fetcher` at all.
    if (options.signal?.aborted) {
      return {
        close() {},
        get lastEventId() {
          return lastEventId ?? 0;
        },
      };
    }

    const controller = new AbortController();
    let closed = false;
    const closeReason = () => new Error('ACP stream closed');
    const onAbort = () => controller.abort(options.signal?.reason ?? closeReason());
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const run = async () => {
      if (this.shouldPollTranscript()) {
        await this.pollTranscript({
          controller,
          isClosed: () => closed,
          getLastEventId: () => lastEventId,
          setLastEventId: (id) => { lastEventId = id; },
          options,
        });
        return;
      }
      let retryMs = 250;
      while (!closed && !controller.signal.aborted) {
        options.onState?.('connecting');
        // Reset per connection attempt: only THIS attempt's first delivered
        // event resets `retryMs` — a connection that establishes (200 + a
        // readable body) but never delivers an event before dying must not
        // reset the backoff, or a server that accepts connections and then
        // immediately drops them would get hammered at the fastest retry
        // pace forever instead of backing off.
        let deliveredEventThisAttempt = false;
        try {
          const response = await this.fetcher(this.endpoint, {
            headers: {
              Accept: 'text/event-stream',
              ...(lastEventId !== null ? { 'Last-Event-ID': String(lastEventId) } : {}),
            },
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new AcpTransportError(
              `ACP stream failed with HTTP ${response.status}`,
              response.status,
              isTerminalStatus(response.status),
            );
          }
          if (!response.body) {
            if ((this.options.streamTransport ?? 'auto') === 'auto') {
              await this.pollTranscript({
                controller,
                isClosed: () => closed,
                getLastEventId: () => lastEventId,
                setLastEventId: (id) => { lastEventId = id; },
                options,
              });
              return;
            }
            throw new Error('ACP stream response has no readable body');
          }
          // 'open' fires as soon as the response/body is established, not
          // gated on an actual event arriving — a real transport connection
          // can sit idle between events, and that shouldn't read as "still
          // connecting". The `retryMs` reset below is the separate, stricter
          // gate: it only relaxes backoff once this attempt has proven it
          // can actually deliver data.
          options.onState?.('open');
          await consumeSse(
            response.body,
            (event) => {
              if (!deliveredEventThisAttempt) {
                deliveredEventThisAttempt = true;
                retryMs = 250;
              }
              if (lastEventId !== null && event.id <= lastEventId) return;
              lastEventId = event.id;
              options.onEvent(event);
            },
            (id, error) => {
              // A poison event (parseable `id:`, unparseable `data:`) must
              // not poison the whole stream: advance past it exactly like a
              // real delivered event so a reconnect's `Last-Event-ID` never
              // re-requests it, report the failure once via `onError`, and
              // keep consuming the stream — do NOT throw out of `consumeSse`.
              if (lastEventId !== null && id <= lastEventId) return;
              lastEventId = id;
              options.onError?.(error);
            },
          );
          if (options.reconnect === false) {
            options.onState?.('closed');
            return;
          }
        } catch (error) {
          if (closed || controller.signal.aborted) return;
          options.onError?.(error);
          if (error instanceof AcpTransportError && error.terminal) {
            options.onState?.('failed');
            return;
          }
          // A one-shot caller (`reconnect: false`) never gets another
          // attempt, so 'reconnecting' would be a lie the consumer waits on
          // forever — mirror the success-path early-return above and report
          // 'closed' instead.
          if (options.reconnect === false) {
            options.onState?.('closed');
            return;
          }
          options.onState?.('reconnecting');
        }
        const jitter = 0.85 + Math.random() * 0.3;
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs * jitter, 5_000)));
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    };
    // Deferred to a microtask so the caller (e.g. `AcpSession.connect()`)
    // always finishes assigning the returned handle to its own state BEFORE
    // any `onEvent`/`onError`/`onState` callback can fire — `run()`'s body
    // executes synchronously up to its first `await`, and that first
    // `onState('connecting')` call happens before any `await`, so without
    // this deferral it could fire while the caller's own bookkeeping (e.g. a
    // `this.stream !== handle` identity guard) still points at the *previous*
    // stream.
    queueMicrotask(() => void run());

    return {
      close() {
        closed = true;
        // Symmetric with the `addEventListener` above: without this, a
        // long-lived `options.signal` (e.g. a component's abort controller
        // reused across many `connect()` calls) would accumulate one
        // listener per closed stream forever.
        options.signal?.removeEventListener('abort', onAbort);
        controller.abort(closeReason());
        options.onState?.('closed');
      },
      get lastEventId() {
        return lastEventId ?? 0;
      },
    };
  }

  private shouldPollTranscript(): boolean {
    const transport = this.options.streamTransport ?? 'auto';
    if (transport === 'poll') return true;
    if (transport === 'sse') return false;
    return typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
  }

  private async pollTranscript(input: {
    controller: AbortController;
    isClosed(): boolean;
    getLastEventId(): number | null;
    setLastEventId(id: number): void;
    options: {
      onEvent(event: AcpStreamEvent): void;
      onError?(error: unknown): void;
      onState?(state: AcpConnectionState): void;
      reconnect?: boolean;
    };
  }): Promise<void> {
    // Persists across EVERY iteration of the `while` loop below, including
    // ones that hit the `catch` — an error never resets it — so a mid-loop
    // error resumes the next poll from `?after=<lastSeenOrdinal>` instead of
    // refetching the whole transcript from ordinal 0. `lastEventId` (a
    // STREAM EVENT id, seeded from `connect({ lastEventId })` for cross-
    // connect resume) is a different sequence than `afterOrdinal` (a row
    // ORDINAL) — reconciling them isn't needed because event-id dedupe below
    // already skips any row whose `streamEventId` was already delivered, so
    // the only cost of not seeding `afterOrdinal` from `lastEventId` is one
    // wasted full-transcript refetch on the very first poll of a resumed
    // connection.
    let afterOrdinal = 0;
    const intervalMs = Math.max(50, this.options.transcriptPollIntervalMs ?? 500);
    // Mirrors the SSE loop's semantics: 'connecting' before each poll,
    // 'open' once a poll succeeds, terminal transport errors stop the loop
    // with 'failed', non-terminal ones report 'reconnecting' and keep going.
    while (!input.isClosed() && !input.controller.signal.aborted) {
      input.options.onState?.('connecting');
      try {
        const history = await this.transcript(afterOrdinal || undefined, input.controller.signal);
        input.options.onState?.('open');
        for (const row of history.envelopes) {
          afterOrdinal = Math.max(afterOrdinal, row.ordinal);
          if (row.direction !== 'agent_to_client') continue;
          const eventId = row.streamEventId;
          if (eventId === null || !Number.isSafeInteger(eventId)) continue;
          const lastEventId = input.getLastEventId();
          if (lastEventId !== null && eventId <= lastEventId) continue;
          input.setLastEventId(eventId);
          input.options.onEvent({ id: eventId, envelope: row.envelope });
          if (input.isClosed() || input.controller.signal.aborted) return;
        }
        if (input.options.reconnect === false) {
          input.options.onState?.('closed');
          return;
        }
      } catch (error) {
        if (input.isClosed() || input.controller.signal.aborted) return;
        input.options.onError?.(error);
        if (error instanceof AcpTransportError && error.terminal) {
          input.options.onState?.('failed');
          return;
        }
        // A one-shot caller (`reconnect: false`) never gets another attempt,
        // so 'reconnecting' would be a lie the consumer waits on forever —
        // mirror the success-path early-return above and report 'closed'.
        if (input.options.reconnect === false) {
          input.options.onState?.('closed');
          return;
        }
        input.options.onState?.('reconnecting');
      }
      await abortableDelay(intervalMs, input.controller.signal);
    }
  }

  private async post(envelope: AcpEnvelope): Promise<AcpEnvelope | null> {
    const response = await this.fetcher(`${this.endpoint}${this.agentQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (response.status === 202 || response.status === 204) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new AcpTransportError(
        `ACP request failed with HTTP ${response.status}: ${text}`,
        response.status,
        isTerminalStatus(response.status),
      );
    }
    return (await response.json()) as AcpEnvelope;
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  emit: (event: AcpStreamEvent) => void,
  onParseError?: (id: number, error: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let holdback = '';
    if (!done && buffer.endsWith('\r')) {
      holdback = '\r';
      buffer = buffer.slice(0, -1);
    }
    buffer = buffer.replace(/\r\n|\r/g, '\n');
    // A finite test/server response may close immediately after the final
    // event's terminating newline instead of sending another blank line.
    if (done && buffer.trim()) buffer += '\n\n';
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let id: number | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        else if (line.startsWith('data:')) data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
      }
      if (id !== null && Number.isSafeInteger(id) && data.length) {
        // A poison event (a well-formed `id:` line but unparseable `data:`)
        // must not throw out of `consumeSse` — that would tear down the
        // whole stream (and trigger a reconnect loop) over one bad event.
        // Report it via `onParseError` and keep consuming the rest of the
        // stream; the caller still advances its `lastEventId` past this id
        // so a reconnect never re-requests the same poison event forever.
        try {
          const envelope = JSON.parse(data.join('\n')) as AcpEnvelope;
          emit({ id, envelope });
        } catch (error) {
          onParseError?.(id, error);
        }
      }
    }
    buffer += holdback;
    if (done) return;
  }
}

export function createAcpClient(options: AcpClientOptions): AcpClient {
  return new AcpClient(options);
}
