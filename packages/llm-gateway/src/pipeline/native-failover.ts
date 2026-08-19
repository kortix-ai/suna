import { UpstreamHttpError } from '../errors';
import type { GatewayLogger } from '../domain';
import { type FullStreamPart, fullStreamPartHasContent } from '../transports/ai-sdk';
import { LIMIT_STATUSES } from './failover';

// ---------------------------------------------------------------------------
// AI-SDK-NATIVE per-turn failover — the typed analog of pipeline/failover.ts +
// the empty-completion retry loop in pipeline/handler.ts, for streamText's
// `fullStream` (typed `TextStreamPart`s) instead of OpenAI-shaped SSE bytes.
//
// WHY A SEPARATE MODULE, not a reuse of runFailover/probeStream/relayStream:
// those three operate on `ReadableStream<Uint8Array>` carrying OpenAI
// chat.completions SSE — they byte-scan for `choices[].delta.content` and for
// `data: {"error":...}` frames. The native path never has those bytes: it has a
// typed part union, so content/error detection is a `switch` on `part.type`, not
// a regex over a decoded buffer. Duplicating the ~loop here (rather than forcing
// a pluggable byte/typed scanner into the byte path) keeps the byte path
// completely untouched. The ONE piece that is genuinely shared — the
// limit-vs-terminal 4xx classification — is imported (`LIMIT_STATUSES`) so both
// paths fail over on the exact same status set.
//
// The semantics mirror the byte path 1:1:
//   1. Iterate candidates in the resolved order.
//   2. PROBE each candidate's stream until the first CONTENT part, an ERROR
//      part / connect throw, the stream ends with no content (empty completion),
//      or a commit deadline elapses with the stream still live.
//   3. Content or deadline → COMMIT that candidate: relay the buffered parts,
//      then the rest of the same stream (a fullStream iterates once, so the
//      probe buffers what it consumed and the commit replays it — exactly the
//      `primed.chunks` replay probeStream/relayStream do for bytes).
//   4. Error part → classify via the caller-supplied `toTransportError`
//      (transports/ai-sdk/index.ts): a LIMIT_STATUS (402/403/429) or a
//      retryable network/5xx fails over to the NEXT candidate; a terminal 4xx
//      (400/401/404/...) fails FAST with no failover.
//   5. Empty completion → retry the SAME candidate up to
//      `maxInvalidAttempts` (MAX_INVALID_COMPLETION_ATTEMPTS_PER_CANDIDATE),
//      then fail over to the next candidate.
//   6. Once a candidate is COMMITTED, no further candidate switch happens — a
//      mid-stream error after commit rides through as an `error` frame in the
//      serialized output (aiGatewaySseFromFullStream turns the `error` part into
//      the wire error frame). This module never sees post-commit errors.
// ---------------------------------------------------------------------------

export type { FullStreamPart };

// The commit deadline: how long the probe waits for the first CONTENT part
// before it commits a still-live-but-slow candidate to the client rather than
// failing over. Mirrors streaming.ts's PROBE_COMMIT_DEADLINE_MS reasoning: a
// slow candidate (long prefill/thinking before the first reasoning delta) is not
// a broken one, and must not be swapped out. Only a genuine end-of-stream,
// error, or connect failure fails over. Kept under Cloudflare's 125s origin
// read timeout so the client never sees a 524 before the gateway commits.
export const NATIVE_PROBE_COMMIT_DEADLINE_MS = 30_000;

type StartStream<C> = (candidate: C) => AsyncIterable<FullStreamPart>;

export interface NativeFailoverDeps<C> {
  /** Resolved candidates, in the order the route policy produced them. */
  candidates: C[];
  /** The provider name for a candidate — used to tag `toTransportError`. */
  providerOf: (candidate: C) => string;
  /**
   * Open a FRESH upstream stream for this candidate. Called once per attempt
   * (an empty-completion retry calls it again), so it must build a new
   * `streamText` each time. May throw synchronously (a connect-time
   * `InvalidPromptError`/misconfig) — that is classified exactly like an
   * `error` part.
   */
  startStream: StartStream<C>;
  /** Maps an AI-SDK error (or `error`-part payload) into the gateway taxonomy —
   *  transports/ai-sdk/index.ts's `toTransportError`. */
  toTransportError: (err: unknown, provider: string) => Error;
  /** MAX_INVALID_COMPLETION_ATTEMPTS_PER_CANDIDATE (handler.ts). */
  maxInvalidAttempts: number;
  logger: GatewayLogger;
  requestId: string;
  /** Overridable for tests; defaults to NATIVE_PROBE_COMMIT_DEADLINE_MS. */
  commitDeadlineMs?: number;
}

export interface NativeCommit<C> {
  kind: 'committed';
  candidate: C;
  /** The full stream to serialize: buffered probe parts, then the rest. */
  stream: AsyncIterable<FullStreamPart>;
  /** True when the probe committed on its deadline (slow-but-live), not on
   *  content — informational for logging/tracing. */
  slowCommit: boolean;
}

export interface NativeFailure {
  kind: 'failed';
  /** 'empty' when every candidate produced an empty completion; 'error' when a
   *  terminal 4xx failed fast or the last candidate errored. */
  reason: 'empty' | 'error';
  /** The classified error behind the failure, when reason === 'error'. Its
   *  `UpstreamHttpError.status` drives the response status. */
  transportError?: Error;
  /** The upstream message the client should see. */
  message: string;
  /** The provider of the candidate that produced the terminal failure. */
  provider: string;
}

export type NativeFailoverResult<C> = NativeCommit<C> | NativeFailure;

type ProbeOutcome =
  | { kind: 'content'; buffered: FullStreamPart[] }
  | {
      kind: 'timeout';
      buffered: FullStreamPart[];
      pending: Promise<IteratorResult<FullStreamPart>>;
    }
  | { kind: 'empty'; buffered: FullStreamPart[] }
  | { kind: 'error'; buffered: FullStreamPart[]; error: unknown };

// Read typed parts until the first content part, an error part / read throw, the
// stream ends with no content, or the commit deadline elapses. Exactly one
// `iterator.next()` is kept in flight at a time; on the deadline branch that
// in-flight read is handed back as `pending` so the commit replay can adopt it
// rather than issuing a second `next()` that would queue behind it and drop the
// part it resolves with (the typed analog of probeStream's `pendingRead`).
async function probeFullStream(
  iterator: AsyncIterator<FullStreamPart>,
  commitDeadlineMs: number,
): Promise<ProbeOutcome> {
  const buffered: FullStreamPart[] = [];
  for (;;) {
    const pending = iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending.then(
        (result) => ({ kind: 'settled' as const, result }),
        (error: unknown) => ({ kind: 'throw' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), commitDeadlineMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (settled.kind === 'timeout') {
      return { kind: 'timeout', buffered, pending };
    }
    if (settled.kind === 'throw') {
      return { kind: 'error', buffered, error: settled.error };
    }
    const { done, value } = settled.result;
    if (done) {
      return { kind: 'empty', buffered };
    }
    if (!value) continue;
    buffered.push(value);
    if (value.type === 'error') {
      // The error part's payload is the raw upstream/SDK error — classify it.
      return { kind: 'error', buffered, error: (value as { error?: unknown }).error ?? value };
    }
    if (fullStreamPartHasContent(value)) {
      return { kind: 'content', buffered };
    }
  }
}

// Build the committed stream: replay the buffered parts, then the read that was
// still in flight at the commit deadline (if any), then the rest of the source.
async function* replayFullStream(
  buffered: FullStreamPart[],
  iterator: AsyncIterator<FullStreamPart>,
  pending?: Promise<IteratorResult<FullStreamPart>>,
): AsyncGenerator<FullStreamPart> {
  for (const part of buffered) yield part;
  if (pending) {
    const { done, value } = await pending;
    if (done) return;
    if (value) yield value;
  }
  for (;;) {
    const { done, value } = await iterator.next();
    if (done) return;
    if (value) yield value;
  }
}

async function cancelIterator(iterator: AsyncIterator<FullStreamPart>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Already closed / errored — nothing to clean up.
  }
}

// A retryable transport error is one worth trying the NEXT candidate for: a
// provider limit (402/403/429), any 5xx, or a network/timeout/unknown error
// with no status. A terminal 4xx (400/401/404/422/...) is the client's request
// being wrong for THIS turn — no candidate will fix it, so it fails fast. This
// is the same limit-vs-terminal split runFailover applies to a thrown
// UpstreamHttpError, keyed off the SHARED LIMIT_STATUSES set.
function isRetryableTransportError(err: Error): boolean {
  if (err instanceof UpstreamHttpError) {
    if (LIMIT_STATUSES.has(err.status)) return true;
    return err.status >= 500;
  }
  return true;
}

export async function runNativeFailover<C>(
  deps: NativeFailoverDeps<C>,
): Promise<NativeFailoverResult<C>> {
  const {
    candidates,
    providerOf,
    startStream,
    toTransportError,
    maxInvalidAttempts,
    logger,
    requestId,
  } = deps;
  const commitDeadlineMs = deps.commitDeadlineMs ?? NATIVE_PROBE_COMMIT_DEADLINE_MS;

  let lastFailure: NativeFailure | null = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const provider = providerOf(candidate);
    const hasNext = i < candidates.length - 1;

    // Retry the SAME candidate up to maxInvalidAttempts on an empty completion,
    // then fall through to the next candidate.
    for (let attempt = 1; ; attempt += 1) {
      let iterator: AsyncIterator<FullStreamPart>;
      try {
        iterator = startStream(candidate)[Symbol.asyncIterator]();
      } catch (err) {
        // streamText threw synchronously (connect-time misconfig / invalid
        // prompt) — treat identically to a first `error` part.
        const transportError = toTransportError(err, provider);
        if (isRetryableTransportError(transportError)) {
          lastFailure = {
            kind: 'failed',
            reason: 'error',
            transportError,
            message: transportError.message,
            provider,
          };
          logger.warn(
            `[llm-gateway] native connect failed for ${provider} (retryable) ${requestId}: ${transportError.message}`,
          );
          break; // next candidate
        }
        logger.warn(
          `[llm-gateway] native connect failed for ${provider} (terminal) ${requestId}: ${transportError.message}`,
        );
        return {
          kind: 'failed',
          reason: 'error',
          transportError,
          message: transportError.message,
          provider,
        };
      }

      const probe = await probeFullStream(iterator, commitDeadlineMs);

      if (probe.kind === 'content') {
        return {
          kind: 'committed',
          candidate,
          stream: replayFullStream(probe.buffered, iterator),
          slowCommit: false,
        };
      }
      if (probe.kind === 'timeout') {
        logger.debug?.(
          `[llm-gateway] native committing slow-but-live upstream ${provider} ${requestId} after ${commitDeadlineMs}ms with no content part`,
        );
        return {
          kind: 'committed',
          candidate,
          stream: replayFullStream(probe.buffered, iterator, probe.pending),
          slowCommit: true,
        };
      }
      if (probe.kind === 'empty') {
        await cancelIterator(iterator);
        const exhausted = attempt >= maxInvalidAttempts;
        logger.warn(
          `[llm-gateway] native empty_completion from ${provider} (attempt ${attempt}/${maxInvalidAttempts}), ${exhausted ? 'failing over' : 'retrying same candidate'} ${requestId}`,
        );
        lastFailure = {
          kind: 'failed',
          reason: 'empty',
          message: 'Upstream returned a completion without usable content',
          provider,
        };
        if (exhausted) break; // next candidate
        continue; // retry same candidate
      }

      // probe.kind === 'error'
      await cancelIterator(iterator);
      const transportError = toTransportError(probe.error, provider);
      lastFailure = {
        kind: 'failed',
        reason: 'error',
        transportError,
        message: transportError.message,
        provider,
      };
      if (isRetryableTransportError(transportError)) {
        logger.warn(
          `[llm-gateway] native upstream error from ${provider} (retryable${hasNext ? ', failing over' : ', no fallback'}) ${requestId}: ${transportError.message}`,
        );
        break; // next candidate (or exhausted after the loop)
      }
      // Terminal 4xx — fail FAST, no failover even if a fallback exists.
      logger.warn(
        `[llm-gateway] native upstream error from ${provider} (terminal, failing fast) ${requestId}: ${transportError.message}`,
      );
      return lastFailure;
    }
  }

  // Every candidate was exhausted (all empty) or failed over (all retryable).
  return (
    lastFailure ?? {
      kind: 'failed',
      reason: 'error',
      message: 'No candidate produced a completion',
      provider: '',
    }
  );
}
