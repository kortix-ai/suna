import { describe, expect, test, beforeEach, mock } from 'bun:test';

let promptImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });

// Overridable per-test so "Server URL not ready" (getClient() throwing before
// the runtime url is pinned) can be simulated N times before it starts
// resolving — mirrors the real client's throw during the sandbox-loading
// window (see opencode/client.ts).
let getClientImpl: () => { session: { promptAsync: (args: unknown) => Promise<unknown> } } = () => ({
  session: { promptAsync: (args: unknown) => promptImpl(args) },
});

mock.module('../../core/runtime/client', () => ({
  getClient: () => getClientImpl(),
}));

mock.module('../../core/http/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import { useSyncStore } from '../../browser/stores/sync-store';
import {
  extractSendErrorMessage,
  getSendRetryDelayMs,
  isOpenCodeNotReadyError,
  isTransientSendStatus,
  promptOpenCodeMessage,
} from './messages';

beforeEach(() => {
  promptImpl = async () => ({ data: {} });
  getClientImpl = () => ({ session: { promptAsync: (args: unknown) => promptImpl(args) } });
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
