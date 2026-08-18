import { describe, expect, test, beforeEach, mock } from 'bun:test';

let promptImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });
/** Overridable per-test — the `client.session.abort()` call `abortOpenCodeSession` makes. */
let abortImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });
/** Overridable per-test — the post-abort `client.session.status()` re-read. */
let statusImpl: () => Promise<{ data?: Record<string, { type: string }> }> = async () => ({ data: {} });

// Overridable per-test so "Server URL not ready" (getClient() throwing before
// the runtime url is pinned) can be simulated N times before it starts
// resolving — mirrors the real client's throw during the sandbox-loading
// window (see opencode/client.ts).
let getClientImpl: () => {
  session: {
    promptAsync: (args: unknown) => Promise<unknown>;
    abort?: (args: unknown) => Promise<unknown>;
    status?: () => Promise<unknown>;
  };
} = () => ({
  session: {
    promptAsync: (args: unknown) => promptImpl(args),
    abort: (args: unknown) => abortImpl(args),
    status: () => statusImpl(),
  },
});

mock.module('../../core/runtime/client', () => ({
  getClient: () => getClientImpl(),
}));

mock.module('../../core/http/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import wireIdVectors from '../../../../../tests/spec/wire-message-id.vectors.json';
import { useSyncStore } from '../../browser/stores/sync-store';
import { isAbortError } from '../../core/http/abort-error';
import {
  abortInFlightDeliveries,
  abortOpenCodeSession,
  awaitAbortSettlement,
  extractSendErrorMessage,
  getSendRetryDelayMs,
  isOpenCodeNotReadyError,
  isTransientSendStatus,
  mintSessionWireMessageId,
  promptOpenCodeMessage,
} from './messages';


beforeEach(() => {
  promptImpl = async () => ({ data: {} });
  abortImpl = async () => ({ data: {} });
  statusImpl = async () => ({ data: {} });
  getClientImpl = () => ({
    session: {
      promptAsync: (args: unknown) => promptImpl(args),
      abort: (args: unknown) => abortImpl(args),
      status: () => statusImpl(),
    },
  });
});

describe('promptOpenCodeMessage', () => {
  test('resolves on a successful prompt (via the async/fire-and-forget endpoint)', async () => {
    let captured: unknown;
    promptImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await expect(
      promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toBeUndefined();
    expect(captured).toMatchObject({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });
  });

  test('passes directory through to the wire payload when provided', async () => {
    let captured: unknown;
    promptImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      options: { directory: '/workspace/project' },
    });
    expect(captured).toMatchObject({ directory: '/workspace/project' });
  });

  test('a 402 response throws immediately (not retryable) with the status for billing classification', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      return {
        error: { data: { message: 'Insufficient credits. Balance: $-0.06' } },
        response: new Response(null, { status: 402 }),
      };
    };

    const err = await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).status).toBe(402);
    expect((err as any).response).toEqual({ status: 402 });
    expect((err as Error).message).toBe('Insufficient credits. Balance: $-0.06');
  });

  test('a real 4xx client error is preserved and never retried', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      return {
        error: { message: 'agent crashed' },
        response: new Response(null, { status: 422 }),
      };
    };

    const err = await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(calls).toBe(1);
    expect((err as Error).message).toBe('agent crashed');
    expect((err as any).status).toBe(422);
  });

  test('retries a transient 5xx and resolves once the server recovers', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      if (calls < 3) {
        return { error: { message: 'upstream blip' }, response: new Response(null, { status: 502 }) };
      }
      return { data: {} };
    };

    await expect(
      promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  test('exhausts the transient retry window and throws the final error', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      return { error: { message: 'upstream blip' }, response: new Response(null, { status: 502 }) };
    };

    const err = await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    // TRANSIENT_BACKOFF_MS has 3 entries → 4 total attempts before giving up.
    expect(calls).toBe(4);
    expect((err as Error).message).toBe('upstream blip');
  });

  test('retries a thrown transport error and eventually rejects', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      throw new Error('Failed to fetch');
    };

    const err = await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(calls).toBe(4);
    expect((err as Error).message).toBe('Failed to fetch');
  });

  test('getClient() throwing "Server URL not ready" a few times still lands the send within the boot window', async () => {
    // Regression: getClient() used to be resolved ONCE before the retry loop,
    // so this throw propagated instantly with zero retries and permanently
    // dropped the first prompt of a brand-new session (the runtime url isn't
    // pinned yet). It must now be resolved INSIDE the loop and get the same
    // boot-window retry treatment as the sandbox proxy's 503.
    let getClientCalls = 0;
    getClientImpl = () => {
      getClientCalls++;
      if (getClientCalls < 3) {
        throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
      }
      return { session: { promptAsync: (args: unknown) => promptImpl(args) } };
    };
    let promptCalls = 0;
    promptImpl = async () => {
      promptCalls++;
      return { data: {} };
    };

    await expect(
      promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toBeUndefined();

    expect(getClientCalls).toBe(3);
    expect(promptCalls).toBe(1);
  });

  test('getClient() never becoming ready exhausts the boot window and throws', async () => {
    let getClientCalls = 0;
    getClientImpl = () => {
      getClientCalls++;
      throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
    };

    // The full boot window is ~29s of real backoff (see BOOT_BACKOFF_MS) —
    // collapse the waits to fire immediately so this test exercises the
    // "never recovers" exhaustion path without blocking the suite for half a
    // minute; the attempt-count/classification logic under test is unaffected.
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: unknown[]) => void,
    ) => realSetTimeout(fn, 0)) as typeof setTimeout;
    try {
      const err = await promptOpenCodeMessage({
        sessionId: 'sess-1',
        parts: [{ type: 'text', text: 'hi' }],
      }).then(
        () => undefined,
        (e) => e,
      );

      // BOOT_BACKOFF_MS has 10 entries → 11 total attempts before giving up.
      expect(getClientCalls).toBe(11);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Server URL not ready');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

// ── One prompt submission = one client-minted messageID ────────────────────
//
// The Kortix sandbox proxy dedupes a prompt delivery by its Idempotency-Key
// or — when the caller sends none, which the browser never does — by a sha256
// of the REQUEST BODY, with a 60s TTL
// (`apps/api/src/sandbox-proxy/prompt-dedupe.ts`, `promptDeliveryKey`). A
// repeat is answered `200 {"status":"duplicate","deduplicated":true}` and is
// never forwarded to opencode.
//
// `promptOpenCodeMessage` used to build a payload out of nothing but the
// session id, the mapped parts (part ids dropped) and the model/agent picks —
// so sending the SAME text twice inside 60s produced a byte-identical body,
// the second POST hashed to the same key, and the message was silently lost:
// no error, no turn, nothing on screen. A per-submission `messageID` makes the
// two bodies differ by construction, while a retry of ONE submission keeps its
// id so the proxy's real duplicate protection still fires.
const ID_TIME_MASK = 0xffffffffffffn;
/** The 12-hex time field of a `msg_…`/`prt_…` wire id, decoded. */
const encodedOf = (id: string): bigint => BigInt(`0x${id.slice(4, 16)}`);
/** What opencode's `Identifier.ascending()` encodes for a given wall clock. */
const encodedAt = (ms: number): bigint => (BigInt(ms) * 0x1000n) & ID_TIME_MASK;
const wireMessageId = (ms: number): string =>
  `msg_${encodedAt(ms).toString(16).padStart(12, '0')}AAAAAAAAAAAAAA`;

/** Collapse the retry backoff so a boot-window test doesn't cost ~30s. */
async function withInstantBackoff<T>(run: () => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
  ) => realSetTimeout(fn, 0)) as typeof setTimeout;
  try {
    return await run();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

/** Flush pending microtasks (promise resolutions) without advancing real timers. */
async function tick(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe('promptOpenCodeMessage messageID', () => {
  let captured: Array<Record<string, unknown>>;

  beforeEach(() => {
    captured = [];
    promptImpl = async (args) => {
      captured.push(args as Record<string, unknown>);
      return { data: {} };
    };
    useSyncStore.setState({ messages: {} });
  });

  test('mints a messageID for a submission that carries none', async () => {
    await promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });

    expect(captured).toHaveLength(1);
    expect(captured[0].messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  test('two identical submissions differ, so the proxy cannot hash them to one delivery', async () => {
    await promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });
    await promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });

    expect(captured).toHaveLength(2);
    const [first, second] = captured;
    expect(first.messageID).toBeTruthy();
    expect(second.messageID).toBeTruthy();
    expect(first.messageID).not.toBe(second.messageID);
    // Everything ELSE is byte-identical — the id is the only thing separating
    // the two deliveries, which is exactly the claim being made.
    expect({ ...first, messageID: null }).toEqual({ ...second, messageID: null });
  });

  test('the internal boot-window retry loop re-sends ONE messageID, not a new one per attempt', async () => {
    // A new id per attempt would defeat the proxy's dedupe claim and let a
    // retry double-enqueue the same prompt — the 3x-queued bug.
    let calls = 0;
    promptImpl = async (args) => {
      captured.push(args as Record<string, unknown>);
      calls++;
      if (calls < 3) {
        return {
          error: { message: 'opencode not ready' },
          response: new Response(null, { status: 503 }),
        };
      }
      return { data: {} };
    };

    await withInstantBackoff(() =>
      promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }),
    );

    expect(captured).toHaveLength(3);
    expect(captured[0].messageID).toBeTruthy();
    expect(new Set(captured.map((p) => p.messageID)).size).toBe(1);
  });

  test('a browser clock AHEAD of the sandbox still mints BELOW the next server id', async () => {
    // K1. opencode mints the assistant reply from the SANDBOX clock; this mints
    // the user message from the BROWSER clock. Trust the browser and a machine
    // running fast puts its own prompt ABOVE the reply that answers it — the
    // sync store sorts by raw id (`a.id < b.id`), so the transcript renders the
    // answer above the question, permanently, for that user.
    //
    // The fix is an asymmetry, not a skew estimate: too EARLY is harmless
    // (the lift-above-newest guard below corrects it), too LATE is the bug. So
    // the mint is backdated and then lifted, never trusted forward.
    const sandboxNow = Date.parse('2026-08-12T12:00:00.000Z');
    // The transcript proves where the sandbox clock actually is.
    useSyncStore.setState({
      messages: { 'sess-skew': [{ id: wireMessageId(sandboxNow - 1_000) }] as never },
    });

    const realNow = Date.now;
    // Browser runs 60s fast — well inside ordinary unsynced-clock drift.
    Date.now = () => sandboxNow + 60_000;
    try {
      await promptOpenCodeMessage({
        sessionId: 'sess-skew',
        parts: [{ type: 'text', text: 'hi' }],
      });
    } finally {
      Date.now = realNow;
    }

    const minted = encodedOf(captured[0].messageID as string);
    // Above everything already on record, so opencode does not read the prompt
    // as already answered...
    expect(minted).toBeGreaterThan(encodedOf(wireMessageId(sandboxNow - 1_000)));
    // ...and below what the sandbox will mint next, so the reply sorts after it.
    expect(minted).toBeLessThan(encodedAt(sandboxNow));
  });

  test('a normal clock still mints above the newest known message', async () => {
    // The backdate must not push a mint BELOW real history — that is the other
    // failure mode, and it is worse: opencode reads a stale assistant reply as
    // the answer and the turn never runs at all.
    const now = Date.now();
    useSyncStore.setState({
      messages: { 'sess-ok': [{ id: wireMessageId(now - 2_000) }] as never },
    });

    await promptOpenCodeMessage({
      sessionId: 'sess-ok',
      parts: [{ type: 'text', text: 'hi' }],
    });

    expect(encodedOf(captured[0].messageID as string)).toBeGreaterThan(
      encodedOf(wireMessageId(now - 2_000)),
    );
  });

  test('a caller-supplied messageID is never overwritten', async () => {
    await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      messageID: 'msg_callersupplied000000000',
    });

    expect(captured[0].messageID).toBe('msg_callersupplied000000000');
  });

  test('a HOST retry of one submission reuses its messageID, so the proxy still absorbs it', async () => {
    // The internal retry loop above is not the only retry. A queued message
    // that failed is re-dispatched by the host (message-queue `retry` →
    // `sendQueuedMessage` → `handleSend` → `sendParts`), which is a FRESH call
    // to this function. Minting per call there means a prompt that reached
    // opencode but reported failure is delivered TWICE — the proxy's 60s body
    // hash can no longer absorb it, because the id makes the bodies differ.
    // `clientMessageId` is the queue entry's own stable key (see
    // `QueuedMessageInput.clientMessageId`), so one submission keeps one id
    // across every dispatch of it.
    await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_7',
    });
    await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_7',
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].messageID).toBeTruthy();
    expect(captured[1].messageID).toBe(captured[0].messageID);
    // …and the whole body with it, which is what the proxy actually hashes.
    expect(captured[0]).toEqual(captured[1]);
  });

  test('two DIFFERENT submissions of the same text keep different ids', async () => {
    // The other half of the contract: a deliberate identical re-send is a new
    // submission with a new queue entry, and must NOT be swallowed as a
    // duplicate. Threading the stable id must not undo that.
    await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_7',
    });
    await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_8',
    });

    expect(captured[0].messageID).not.toBe(captured[1].messageID);
  });

  test('the stable id is scoped per session, so one queue key cannot collide across sessions', async () => {
    // Queue keys are minted per host store, not globally, and a message id has
    // to sort against ITS session's transcript. Two sessions sharing a key must
    // not share an id.
    await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_7',
    });
    await promptOpenCodeMessage({
      sessionId: 'sess-2',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_7',
    });

    expect(captured[0].messageID).not.toBe(captured[1].messageID);
  });

  test('an explicit messageID still wins over a clientMessageId', async () => {
    await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_7',
      messageID: 'msg_callersupplied000000000',
    });

    expect(captured[0].messageID).toBe('msg_callersupplied000000000');
  });

  test('the remembered ids are bounded, and forgetting only degrades to a fresh id', async () => {
    // A long-lived tab must not accumulate one entry per message forever. The
    // cache is a small insertion-ordered window: past it the oldest submission
    // re-mints, which is exactly today's behaviour, never a wrong id.
    await promptOpenCodeMessage({
      sessionId: 'sess-bound',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_first',
    });
    const first = captured[0].messageID;
    for (let i = 0; i < 256; i++) {
      await promptOpenCodeMessage({
        sessionId: 'sess-bound',
        parts: [{ type: 'text', text: 'hi' }],
        clientMessageId: `cm_filler_${i}`,
      });
    }
    await promptOpenCodeMessage({
      sessionId: 'sess-bound',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_first',
    });

    expect(captured[captured.length - 1].messageID).not.toBe(first);
    // The MOST RECENT submission is still remembered — the window evicts the
    // oldest, not everything.
    await promptOpenCodeMessage({
      sessionId: 'sess-bound',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_filler_255',
    });
    const recent = captured.filter((p) => p.messageID === captured[256].messageID);
    expect(recent).toHaveLength(2);
  });

  test('encodes the LOW 48 bits of the clock, exactly like opencode Identifier.ascending()', async () => {
    // Not a cosmetic detail. opencode writes `(Date.now() * 0x1000 + counter)`
    // truncated to its low 6 bytes; the `ascendingId` helper in this module
    // keeps the HIGH 12 hex digits instead (`.slice(0, 12)` of a 14-digit
    // string), which today yields `msg_19ff…` where the server mints
    // `msg_fa4a…`. A message id in that format sorts BEFORE every id the
    // server ever made, so it lands at the top of the transcript and the
    // server's own "has this prompt already been answered?" ordering check
    // reads a stale assistant reply as the answer to it — which is why
    // apps/web deliberately sends no client ids today.
    const before = Date.now();
    await promptOpenCodeMessage({ sessionId: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });
    const after = Date.now();

    // The window is the browser clock MINUS `CLOCK_SKEW_BACKDATE_MS`: a mint is
    // deliberately backdated so it can never sort above the reply that answers
    // it, then lifted into place off the transcript (see the constant's note in
    // messages.ts). Pinned here rather than imported — the constant is internal,
    // and a change to it SHOULD have to be restated in this test.
    const BACKDATE_MS = 2 * 60 * 1000;
    const minted = encodedOf(captured[0].messageID as string);
    expect(minted).toBeGreaterThanOrEqual(encodedAt(before - BACKDATE_MS));
    // Small slack for the monotonic tie-break that separates same-millisecond
    // submissions; anything larger means the clock is not what is encoded.
    // This bound is what still catches the HIGH-bits regression — `msg_19ff…`
    // is a different order of magnitude, not a near miss.
    expect(minted).toBeLessThanOrEqual(encodedAt(after - BACKDATE_MS) + 1000n);
  });

  test('outranks the newest message already in the session when the browser clock lags', async () => {
    const skewed = wireMessageId(Date.now() + 10 * 60_000);
    useSyncStore.setState({
      messages: { 'sess-skew': [{ id: skewed, role: 'user' } as never] },
    });

    await promptOpenCodeMessage({ sessionId: 'sess-skew', parts: [{ type: 'text', text: 'hi' }] });

    expect(encodedOf(captured[0].messageID as string)).toBeGreaterThan(encodedOf(skewed));
  });

  test('ignores a wildly-out-of-range id in the store instead of jumping the clock to it', async () => {
    // A wrapped/garbage id must not drag every later id 30 days into the
    // future — the correction is a bounded clock-skew fix, not a follow-me.
    const absurd = wireMessageId(Date.now() + 30 * 24 * 60 * 60_000);
    useSyncStore.setState({
      messages: { 'sess-absurd': [{ id: absurd, role: 'user' } as never] },
    });

    const before = Date.now();
    await promptOpenCodeMessage({ sessionId: 'sess-absurd', parts: [{ type: 'text', text: 'hi' }] });

    const minted = encodedOf(captured[0].messageID as string);
    expect(minted).toBeLessThan(encodedAt(before + 60_000));
  });

  // ── Golden vectors shared with apps/api ────────────────────────────────
  //
  // The control plane re-mints a wire id when it redelivers an abandoned
  // prompt (`apps/api/src/projects/wire-message-id.ts`). It cannot import this
  // module — `apps/api` has no `@kortix/sdk` dependency, and the minter here
  // reads the browser sync store — so there are two implementations of one
  // ordering contract. A silent divergence drops turns: OpenCode decides "has
  // this prompt already been answered?" by id order. This fixture is what
  // makes a divergence fail TWO suites instead of zero.
  describe('golden vectors — tests/spec/wire-message-id.vectors.json', () => {
    for (const [index, vector] of wireIdVectors.vectors.entries()) {
      test(vector.name, async () => {
        const sessionId = `sess-vector-${index}`;
        if (vector.newestKnownTime !== null) {
          useSyncStore.setState({
            messages: {
              [sessionId]: [
                { id: `msg_${vector.newestKnownTime}AAAAAAAAAAAAAA`, role: 'user' } as never,
              ],
            },
          });
        }
        const realNow = Date.now;
        Date.now = () => vector.nowMs;
        try {
          await promptOpenCodeMessage({ sessionId, parts: [{ type: 'text', text: 'hi' }] });
        } finally {
          Date.now = realNow;
        }
        expect((captured[0].messageID as string).slice(4, 16)).toBe(vector.expectedTime);
      });
    }
  });
});

// ── T9: cancel() cancels in-flight delivery and awaits the abort ───
//
// Before this, a prompt still retrying its boot-window backoff when the user
// hit Stop had no `AbortSignal` at all — it landed AFTER the abort and ran
// the OLD text. `abortInFlightDeliveries` lets `cancel()` reach every
// in-flight `promptOpenCodeMessage` call for a session and stop it before its
// next attempt, whether that attempt is mid-network-call or mid-backoff-sleep.
describe('abortInFlightDeliveries', () => {
  test('a delivery mid-retry-backoff is aborted before its next attempt fires', async () => {
    let calls = 0;
    promptImpl = async () => {
      calls++;
      // Always transient — without an abort this would retry across the full
      // boot window and eventually succeed or exhaust it. The abort must cut
      // it off after the FIRST attempt, before the second ever happens.
      return { error: { message: 'opencode not ready' }, response: new Response(null, { status: 503 }) };
    };

    const delivery = promptOpenCodeMessage({
      sessionId: 'sess-abort-1',
      parts: [{ type: 'text', text: 'hi' }],
    });
    // Flush microtasks so the first attempt completes and the retry loop is
    // now waiting on the (real, ~400ms) backoff timer — but nowhere near firing
    // it, so this assertion is deterministic without a real wait.
    await tick(10);
    expect(calls).toBe(1);

    const aborted = abortInFlightDeliveries('sess-abort-1');
    expect(aborted).toBe(1);

    const result = await delivery.then(
      () => 'resolved',
      (e) => e,
    );
    expect(isAbortError(result)).toBe(true);
    // The retry loop never got to fire its second attempt.
    expect(calls).toBe(1);
  });

  test('aborts a delivery waiting on getClient() during the boot-window retry', async () => {
    let getClientCalls = 0;
    getClientImpl = () => {
      getClientCalls++;
      throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
    };

    const delivery = promptOpenCodeMessage({
      sessionId: 'sess-abort-2',
      parts: [{ type: 'text', text: 'hi' }],
    });
    await tick(10);
    expect(getClientCalls).toBe(1);

    abortInFlightDeliveries('sess-abort-2');

    const result = await delivery.then(
      () => 'resolved',
      (e) => e,
    );
    expect(isAbortError(result)).toBe(true);
    expect(getClientCalls).toBe(1);
  });

  test('returns 0 and is a no-op when nothing is in flight for that session', () => {
    expect(abortInFlightDeliveries('sess-nothing-in-flight')).toBe(0);
  });

  test('aborting one session never touches another session in flight at the same time', async () => {
    let callsA = 0;
    let callsB = 0;
    promptImpl = async (args) => {
      const sessionID = (args as { sessionID: string }).sessionID;
      if (sessionID === 'sess-a') callsA++;
      else callsB++;
      return { error: { message: 'opencode not ready' }, response: new Response(null, { status: 503 }) };
    };

    const deliveryA = promptOpenCodeMessage({ sessionId: 'sess-a', parts: [{ type: 'text', text: 'hi' }] });
    const deliveryB = promptOpenCodeMessage({ sessionId: 'sess-b', parts: [{ type: 'text', text: 'hi' }] });
    await tick(10);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1);

    abortInFlightDeliveries('sess-a');
    const resultA = await deliveryA.then(
      () => 'resolved',
      (e) => e,
    );
    expect(isAbortError(resultA)).toBe(true);

    // B was never touched — its own (real, ~400ms) backoff timer is still
    // running, untouched by A's abort. Let it fire and succeed on its own
    // (not aborted — resolves cleanly instead of rejecting).
    promptImpl = async (args) => {
      const sessionID = (args as { sessionID: string }).sessionID;
      if (sessionID === 'sess-b') callsB++;
      return { data: {} };
    };
    await expect(deliveryB).resolves.toBeUndefined();
    expect(callsB).toBeGreaterThanOrEqual(2);
  });

  test('a resolved delivery unregisters itself — a later abort call finds nothing', async () => {
    promptImpl = async () => ({ data: {} });
    await promptOpenCodeMessage({ sessionId: 'sess-done', parts: [{ type: 'text', text: 'hi' }] });

    expect(abortInFlightDeliveries('sess-done')).toBe(0);
  });
});

describe('abortOpenCodeSession', () => {
  test('POSTs the abort to the runtime for the given session', async () => {
    let captured: unknown;
    abortImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await expect(abortOpenCodeSession('sess-1')).resolves.toBeUndefined();
    expect(captured).toEqual({ sessionID: 'sess-1' });
  });

  test('force-updates the store when the server still reports busy after the abort', async () => {
    statusImpl = async () => ({ data: { 'sess-1': { type: 'busy' } } });
    useSyncStore.setState({ sessionStatus: {} });

    await abortOpenCodeSession('sess-1');

    expect(useSyncStore.getState().sessionStatus['sess-1']).toEqual({ type: 'busy' });
  });

  test('propagates a genuine abort failure instead of swallowing it', async () => {
    abortImpl = async () => ({
      error: { message: 'boom' },
      response: new Response(null, { status: 500 }),
    });

    await expect(abortOpenCodeSession('sess-1')).rejects.toThrow();
  });

  test('a status-recheck failure after a successful abort is non-fatal', async () => {
    abortImpl = async () => ({ data: {} });
    statusImpl = async () => {
      throw new Error('status endpoint unreachable');
    };

    await expect(abortOpenCodeSession('sess-1')).resolves.toBeUndefined();
  });
});

describe('awaitAbortSettlement', () => {
  test('resolves "aborted" once the abort call resolves — not before', async () => {
    let resolveAbort: () => void = () => {};
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    let settled: unknown;
    const settlement = awaitAbortSettlement(() => abortPromise, 1000).then((r) => {
      settled = r;
    });

    await tick(10);
    expect(settled).toBeUndefined();

    resolveAbort();
    await settlement;
    expect(settled).toEqual({ status: 'aborted' });
  });

  test('a hanging abort call times out with a bounded settlement, not forever', async () => {
    const hanging = new Promise<void>(() => {});

    const result = await awaitAbortSettlement(() => hanging, 20);

    expect(result).toEqual({ status: 'timed-out' });
  });

  test('a failing abort call settles as "failed" with the real error — never silently swallowed', async () => {
    const boom = new Error('abort mutation exhausted its retries');

    const result = await awaitAbortSettlement(() => Promise.reject(boom), 1000);

    expect(result).toEqual({ status: 'failed', error: boom });
  });

  test('the timeout is cleared once the abort call settles, so it never fires late', async () => {
    // Regression guard against a leaked timer: if the timeout weren't
    // cleared, a fast-resolving abort followed by a wait longer than
    // `timeoutMs` would still be fine (the promise already settled), but the
    // dangling timer is exactly the kind of bug that later shows up as an
    // unexplained state flip. Assert the settled VALUE stays 'aborted', not
    // silently swapped to 'timed-out' by a stray timer firing after the fact.
    const result = await awaitAbortSettlement(() => Promise.resolve(), 20);
    await tick(5);
    expect(result).toEqual({ status: 'aborted' });
  });
});

describe('extractSendErrorMessage', () => {
  test('reads thrown Error messages', () => {
    expect(extractSendErrorMessage(new Error('opencode not ready'))).toBe('opencode not ready');
  });

  test('reads plain strings', () => {
    expect(extractSendErrorMessage('opencode not ready')).toBe('opencode not ready');
  });

  test('reads the SDK response-error shape ({ data: { message } })', () => {
    expect(extractSendErrorMessage({ data: { message: 'opencode not ready' } })).toBe(
      'opencode not ready',
    );
  });

  test('reads a top-level message / error field', () => {
    expect(extractSendErrorMessage({ message: 'boom' })).toBe('boom');
    expect(extractSendErrorMessage({ error: 'nope' })).toBe('nope');
  });

  test('returns empty string for nullish input', () => {
    expect(extractSendErrorMessage(null)).toBe('');
    expect(extractSendErrorMessage(undefined)).toBe('');
  });
});

describe('isOpenCodeNotReadyError', () => {
  test('matches the boot 503 across shapes and casing', () => {
    expect(isOpenCodeNotReadyError(new Error('opencode not ready'))).toBe(true);
    expect(isOpenCodeNotReadyError('OpenCode Not Ready')).toBe(true);
    expect(isOpenCodeNotReadyError({ data: { message: 'opencode not ready' } })).toBe(true);
    expect(isOpenCodeNotReadyError('Failed to perform action: opencode not ready')).toBe(true);
  });

  test('does not match unrelated errors', () => {
    expect(isOpenCodeNotReadyError(new Error('Insufficient credits'))).toBe(false);
    expect(isOpenCodeNotReadyError({ data: { message: 'Bad request' } })).toBe(false);
    expect(isOpenCodeNotReadyError(null)).toBe(false);
  });
});

describe('isTransientSendStatus', () => {
  test('treats missing status (thrown transport error) as transient', () => {
    expect(isTransientSendStatus(undefined)).toBe(true);
  });

  test('treats 5xx / 408 / 429 as transient', () => {
    expect(isTransientSendStatus(500)).toBe(true);
    expect(isTransientSendStatus(503)).toBe(true);
    expect(isTransientSendStatus(408)).toBe(true);
    expect(isTransientSendStatus(429)).toBe(true);
  });

  test('treats other 4xx as terminal', () => {
    expect(isTransientSendStatus(400)).toBe(false);
    expect(isTransientSendStatus(401)).toBe(false);
    expect(isTransientSendStatus(404)).toBe(false);
  });
});

describe('getSendRetryDelayMs', () => {
  test('retries "opencode not ready" across the full boot window', () => {
    const err = new Error('opencode not ready');
    // 503 status is reported alongside the boot message.
    const delays: number[] = [];
    for (let attempt = 1; ; attempt++) {
      const delay = getSendRetryDelayMs(attempt, 503, err);
      if (delay === null) break;
      delays.push(delay);
      if (attempt > 20) throw new Error('retry schedule did not terminate');
    }
    // 10 retries → 11 total attempts, covering ~29s of cold boot / wake.
    expect(delays.length).toBe(10);
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(25000);
  });

  test('any 503 uses the boot/wake window even without a tidy message', () => {
    // A 503 from the sandbox proxy always means "not ready / waking", so it must
    // get the long boot window — not the short transient one — so a wake-from-
    // auto-stop send lands instead of reverting a prompt that then runs.
    const opaque = {}; // SDK error whose body didn't carry a message
    const delays: number[] = [];
    for (let attempt = 1; ; attempt++) {
      const delay = getSendRetryDelayMs(attempt, 503, opaque);
      if (delay === null) break;
      delays.push(delay);
      if (attempt > 20) throw new Error('retry schedule did not terminate');
    }
    expect(delays.length).toBe(10);
  });

  test('retries a generic transient 5xx, but only briefly', () => {
    const err = { data: { message: 'upstream blip' } };
    expect(getSendRetryDelayMs(1, 502, err)).toBe(400);
    expect(getSendRetryDelayMs(2, 502, err)).toBe(1000);
    expect(getSendRetryDelayMs(3, 502, err)).toBe(2000);
    // Generic transient window (a non-503 5xx) exhausts after 3 retries.
    expect(getSendRetryDelayMs(4, 502, err)).toBeNull();
  });

  test('retries a thrown transport error (no status)', () => {
    const err = new Error('Failed to fetch');
    expect(getSendRetryDelayMs(1, undefined, err)).toBe(400);
    expect(getSendRetryDelayMs(3, undefined, err)).toBe(2000);
    expect(getSendRetryDelayMs(4, undefined, err)).toBeNull();
  });

  test('never retries a real 4xx client error', () => {
    const err = { data: { message: 'Bad request' } };
    expect(getSendRetryDelayMs(1, 400, err)).toBeNull();
    expect(getSendRetryDelayMs(1, 401, err)).toBeNull();
    expect(getSendRetryDelayMs(1, 404, err)).toBeNull();
  });

  test('"opencode not ready" wins even when surfaced as a non-transient status', () => {
    // Defensive: if the boot 503 is ever relabeled with a 4xx-ish status, the
    // message still drives a boot-window retry.
    const err = new Error('opencode not ready');
    expect(getSendRetryDelayMs(1, 400, err)).toBe(400);
  });
});

// ── The prompt mutation must never be retried by TanStack Query ────────────
//
// `promptOpenCodeMessage` POSTs `prompt_async`, which CREATES a user message.
// Its two siblings — `useExecuteOpenCodeCommand` and the session-init mutation
// — both carry `retry: false` with that exact reasoning; this one did not, so
// it inherited the host's default. apps/web's is:
//
//   retry: (failureCount, error) => {
//     if (error?.status >= 400 && error?.status < 500) return false;
//     return failureCount < 1;                       // ← a 502 lands HERE
//   }
//
// A 502 is >= 500, so the guard misses it and the prompt is re-POSTed. The
// sandbox proxy's content-hash dedupe is the only thing that has been catching
// it, which is precisely the "one layer relies on another's guard" shape that
// produced the 4x duplicate command. A non-idempotent call declares its own
// retry policy.
describe('useSendOpenCodeMessage retry policy', () => {
  const SRC = require('node:fs').readFileSync(
    new URL('./messages.ts', import.meta.url).pathname,
    'utf8',
  ) as string;

  test('declares retry: false rather than inheriting the host default', () => {
    const start = SRC.indexOf('export function useSendOpenCodeMessage()');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('\n}', start));
    expect(body).toContain('retry: false');
  });
});

// ── mintSessionWireMessageId — the id a host hands the SERVER-SIDE inbox ─────
//
// `createSessionPrompt` needs the wire id up front, because the control plane
// cannot place one: ordering an id means reading THIS session's transcript.
describe('mintSessionWireMessageId', () => {
  beforeEach(() => {
    useSyncStore.setState({ messages: {} });
  });

  test('encodes the LOW 48 bits of the clock, the field opencode orders by', async () => {
    // The regression this guards: `ascendingId` keeps the HIGH 12 hex digits of
    // the same number, which is a different quantity entirely — an id in that
    // shape mis-sorts against every server-minted id and the turn is read as
    // already answered. The bound below is what tells the two apart.
    const before = Date.now();
    const id = mintSessionWireMessageId('sess-inbox');
    const after = Date.now();
    expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    const BACKDATE_MS = 2 * 60 * 1000;
    expect(encodedOf(id)).toBeGreaterThanOrEqual(encodedAt(before - BACKDATE_MS));
    expect(encodedOf(id)).toBeLessThanOrEqual(encodedAt(after - BACKDATE_MS) + 1000n);
  });

  test('one clientMessageId always resolves to one id, so a retry keeps its claim', () => {
    const first = mintSessionWireMessageId('sess-inbox', 'q_1');
    expect(mintSessionWireMessageId('sess-inbox', 'q_1')).toBe(first);
    expect(mintSessionWireMessageId('sess-inbox', 'q_2')).not.toBe(first);
  });

  test('places the id above the session transcript it will be delivered into', () => {
    const skewed = wireMessageId(Date.now() + 10 * 60_000);
    useSyncStore.setState({
      messages: { 'sess-inbox-skew': [{ id: skewed, role: 'user' } as never] },
    });
    expect(encodedOf(mintSessionWireMessageId('sess-inbox-skew'))).toBeGreaterThan(
      encodedOf(skewed),
    );
  });

  test('an OPTIMISTIC `ascendingId` message in the store does not disable the lift', () => {
    // THE LIVE DEFECT THIS PINS (reproduced in the browser on the worktree
    // stack, 2026-08-18): every send puts an OPTIMISTIC user message into the
    // same sync store, and that message's id comes from `ascendingId`, which
    // keeps the HIGH hex digits of the id clock (`msg_1a01…`) where opencode
    // keeps the LOW ones (`msg_0141…`). It is therefore ~2.8e13 above every
    // real id. `newestKnownMessageTime` returned it as "newest", the
    // out-of-range guard then refused the correction, and the lift NEVER
    // engaged in the real app — so a prompt sent inside `CLOCK_SKEW_BACKDATE_MS`
    // of the previous reply got a wire id BELOW that reply. OpenCode reads such
    // a prompt as already answered: no turn, no error, the message just sits
    // there. Exactly the silent loss this whole id scheme exists to remove.
    //
    // The scan must therefore ignore ids it cannot place instead of letting one
    // of them veto the correction for the whole session.
    const real = wireMessageId(Date.now() + 10 * 60_000);
    useSyncStore.setState({
      messages: {
        'sess-inbox-optimistic': [
          { id: real, role: 'assistant' } as never,
          // `ascendingId('msg')`'s exact shape for this clock.
          {
            id: `msg_${((BigInt(Date.now()) * 0x1000n).toString(16).padStart(12, '0')).slice(0, 12)}OPTIMISTICxxxx`,
            role: 'user',
          } as never,
        ],
      },
    });
    expect(encodedOf(mintSessionWireMessageId('sess-inbox-optimistic'))).toBeGreaterThan(
      encodedOf(real),
    );
  });

  test('the SECOND prompt of a session outranks the reply to the first', () => {
    // The end-to-end shape of the same defect, stated in wall-clock terms: the
    // sandbox answered 70s ago, well inside the 2-minute backdate. Without the
    // lift the mint lands ~50s BELOW that reply and the turn never runs.
    const answeredAt = Date.now() - 70_000;
    useSyncStore.setState({
      messages: {
        'sess-inbox-recent': [
          { id: wireMessageId(answeredAt - 2_000), role: 'user' } as never,
          { id: wireMessageId(answeredAt), role: 'assistant' } as never,
          {
            id: `msg_${((BigInt(Date.now()) * 0x1000n).toString(16).padStart(12, '0')).slice(0, 12)}OPTIMISTICxxxx`,
            role: 'user',
          } as never,
        ],
      },
    });
    expect(encodedOf(mintSessionWireMessageId('sess-inbox-recent'))).toBeGreaterThan(
      encodedOf(wireMessageId(answeredAt)),
    );
  });
});
