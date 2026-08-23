import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { SESSION_SYNC_PAGE_SIZE } from '../core/session-sync/session-sync-controller';

// Mirrors messages.test.ts / use-session.test.ts: stub the lowest network
// boundary (the OpenCode SDK client singleton) so the real send/recovery
// logic under test runs unmodified.
let lastMessagesArgs: { sessionID: string; limit?: number } | undefined;
let messagesImpl: (args: { sessionID: string; limit?: number }) => Promise<{ data?: unknown }> = async () => ({
  data: undefined,
});
let promptImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });
let getClientThrows: Error | null = null;

mock.module('../core/runtime/client', () => ({
  getClient: () => {
    if (getClientThrows) throw getClientThrows;
    return {
      session: {
        messages: (args: { sessionID: string; limit?: number }) => {
          lastMessagesArgs = args;
          return messagesImpl(args);
        },
        promptAsync: (args: unknown) => promptImpl(args),
      },
    };
  },
}));

mock.module('../core/http/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as any).sessionStorage = new MemoryStorage();
  messagesImpl = async () => ({ data: undefined });
  promptImpl = async () => ({ data: {} });
  getClientThrows = null;
  lastMessagesArgs = undefined;
  useSyncStore.getState().reset();
  useSessionWorkingStore.getState().reset();
});

afterEach(() => {
  delete (globalThis as any).sessionStorage;
});

import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { readStartStash, writeStartStash } from './session-start-stash';
import {
  abandonOptimisticSend,
  applyOptimisticAbort,
  beginOptimisticSend,
  markOptimisticSendDispatched,
  markOptimisticSendInboxBacked,
  recoverFromSendFailure,
  replayStartStash,
  sendAndRecover,
  sendWithReceipt,
  stopWithReceipt,
  type StashReplayTimerHandle,
  type StashReplayTimers,
} from './use-session-send';

async function tick(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe('beginOptimisticSend', () => {
  test('adds the user message and writes NO status — the bubble is not a turn', () => {
    // It used to write `{type:'busy'}` into the slot SSE status frames land
    // in, which is the runtime's own voice: a fabricated frame there is
    // indistinguishable from one the daemon sent, and it outranked a real
    // `/turn` read stamped after it. The receipt (`SendReceipt`) is what
    // says "this tab is waiting on a send"; this function only paints text.
    beginOptimisticSend('sess-1', 'msg-1', 'hello there', ['prt-1']);

    const msgs = useSyncStore.getState().messages['sess-1'];
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0]).toMatchObject({ id: 'msg-1', role: 'user' });
    expect(useSyncStore.getState().parts['msg-1']?.[0]).toMatchObject({ id: 'prt-1', text: 'hello there' });
    expect('sess-1' in useSyncStore.getState().sessionStatus).toBe(false);
  });

  test('the stub carries NO time.created — display order puts it newest, whatever the box clock says', () => {
    // `compareMessagesForDisplay` orders by `time.created`, which the BOX
    // stamps on real messages. A stub stamped from the browser clock sorted
    // ABOVE real messages whenever the box ran behind the browser (measured:
    // ~1 s locally) — "Held B" drawn above "Held A", rapid sends 2..5 drawn
    // above 1. An untimed stub is "the newest thing the user did" by the
    // comparator's own rule, which is the only order that is right on every
    // clock.
    beginOptimisticSend('sess-1', 'msg-1', 'hello there', ['prt-1']);
    const info = useSyncStore.getState().messages['sess-1']?.[0] as { time?: { created?: number } };
    expect(info.time?.created).toBeUndefined();
  });

  test('adds no parts for empty/whitespace-only text', () => {
    beginOptimisticSend('sess-1', 'msg-1', '   ');
    expect(useSyncStore.getState().parts['msg-1'] ?? []).toHaveLength(0);
  });
});

describe('markOptimisticSendInboxBacked', () => {
  test('a message whose inbox row landed survives the idle sweep until its echo', () => {
    // A prompt queued at a sleeping box: the POST returned, the row is durable,
    // the box will answer in a while. The session may see a local idle in
    // between — that used to sweep the bubble and it came back seconds later
    // under the echo. The message stays; the echo confirms it in place.
    beginOptimisticSend('sess-1', 'msg-wire', 'hello there', ['prt-1']);
    markOptimisticSendDispatched('sess-1', 'msg-wire');
    markOptimisticSendInboxBacked('sess-1', 'msg-wire');

    useSyncStore.getState().clearOptimisticMessages('sess-1');
    expect(useSyncStore.getState().messages['sess-1']?.map((m) => m.id)).toEqual(['msg-wire']);

    useSyncStore.getState().hydrate('sess-1', [
      {
        info: { id: 'msg-wire', sessionID: 'sess-1', role: 'user', time: { created: 1 } } as never,
        parts: [],
      },
    ]);
    expect(useSyncStore.getState().messages['sess-1']?.map((m) => m.id)).toEqual(['msg-wire']);
    expect(useSyncStore.getState().hasOptimisticMessages('sess-1')).toBe(false);
  });
});

describe('markOptimisticSendDispatched', () => {
  test('lets the server echo supersede the optimistic message', () => {
    // The bug this exists for: a host that calls `beginOptimisticSend` and
    // then POSTs by hand leaves the message `pending` forever, so nothing the
    // server echoes back can supersede it — and the user sees their own
    // message twice for the whole turn. `sync-store.ts` calls that host
    // "a host that does not exist"; `apps/web`'s session composer is it.
    beginOptimisticSend('sess-1', 'msg-client', 'hello there', ['prt-1']);
    markOptimisticSendDispatched('sess-1', 'msg-client');

    // The server persists the user message before its parts, so the echo
    // carries no part id to correlate on — the dispatched flag is the only
    // thing that can pair them.
    useSyncStore.getState().hydrate('sess-1', [
      {
        info: { id: 'msg-server', sessionID: 'sess-1', role: 'user', time: { created: 1 } } as never,
        parts: [],
      },
    ]);

    const ids = useSyncStore.getState().messages['sess-1']?.map((m) => m.id) ?? [];
    expect(ids).toEqual(['msg-server']);
  });

  test('an unmarked message is left alone — it may still be uploading', () => {
    // Never mark on the host's behalf. A message the server was never told
    // about cannot be a copy of anything it returns, and deleting it would
    // lose text the user typed.
    beginOptimisticSend('sess-1', 'msg-client', 'hello there', ['prt-1']);

    useSyncStore.getState().hydrate('sess-1', [
      {
        info: { id: 'msg-server', sessionID: 'sess-1', role: 'user', time: { created: 1 } } as never,
        parts: [],
      },
    ]);

    const ids = useSyncStore.getState().messages['sess-1']?.map((m) => m.id) ?? [];
    expect(ids).toContain('msg-client');
  });
});

describe('abandonOptimisticSend', () => {
  test('clears the named receipt and removes the optimistic message, writing NO status', () => {
    useSessionWorkingStore.getState().noteSendReceipt('sess-1', { messageId: 'msg-1', atMs: 1 });
    beginOptimisticSend('sess-1', 'msg-1', 'hello');

    abandonOptimisticSend('sess-1', 'msg-1');

    // "Nothing is coming for THIS send" is the honest statement. Writing
    // `idle` into the status slot says "the session is not working", which
    // this path cannot know: a trigger or a second device may be running one.
    expect(useSessionWorkingStore.getState().receipts['sess-1']).toBeUndefined();
    expect('sess-1' in useSyncStore.getState().sessionStatus).toBe(false);
    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-1')).toBe(false);
  });

  test('a LATER send\'s receipt survives an earlier abandon', () => {
    // The named guard in `clearSendReceipt`: a slow failure must not drop the
    // receipt of a send submitted after it whose POST is still on the wire.
    useSessionWorkingStore.getState().noteSendReceipt('sess-1', { messageId: 'msg-2', atMs: 2 });

    abandonOptimisticSend('sess-1', 'msg-1');

    expect(useSessionWorkingStore.getState().receipts['sess-1']).toMatchObject({
      messageId: 'msg-2',
    });
  });
});

describe('recoverFromSendFailure', () => {
  // Reported from a live self-host: the user stopped a turn, sent the next
  // prompt, the SERVER queued it and ran it — and the tab showed nothing. No
  // bubble, no queued row, the composer back on its send arrow. Everything
  // appeared ~30s later when the runtime's echo arrived.
  //
  // The cause is which authority this function asks. A prompt that goes to the
  // durable inbox is a CONTROL-PLANE row waiting for admission; it is not in
  // OpenCode's transcript and will not be until the gate delivers it. Asking
  // `session.messages()` about it therefore always answers "no such message",
  // and the recovery deleted the user's bubble on the strength of that answer —
  // while the row it could not see was already running.
  //
  // The row is addressable: the POST carries a `clientMessageId`, so the
  // ambiguity a lost response creates is RESOLVABLE rather than guessable.
  test('an inbox-backed send whose row exists is a SUCCESS, not a loss', async () => {
    beginOptimisticSend('sess-1', 'msg-1', 'go');
    useSessionWorkingStore.getState().noteSendReceipt('sess-1', { messageId: 'msg-1', atMs: 1 });
    messagesImpl = async () => ({ data: undefined });

    const classified = recoverFromSendFailure('sess-1', 'msg-1', new Error('network down'), {
      inboxRowExists: async () => true,
    });
    await tick();
    await tick();

    // The bubble stays: the server has the prompt and is going to run it.
    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-1')).toBe(true);
    // And the composer keeps saying so — the receipt is re-accepted, because a
    // row the control plane holds is exactly what a receipt is waiting for.
    expect(useSessionWorkingStore.getState().receipts['sess-1']?.messageId).toBe('msg-1');
    expect(classified.kind).toBeDefined();
  });

  test('an inbox-backed send with NO row still drops the bubble', async () => {
    beginOptimisticSend('sess-1', 'msg-2', 'never landed');
    messagesImpl = async () => ({ data: undefined });

    recoverFromSendFailure('sess-1', 'msg-2', new Error('network down'), {
      inboxRowExists: async () => false,
    });
    await tick();
    await tick();

    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-2')).toBe(false);
  });

  test('an inbox lookup that itself fails keeps the bubble — ambiguity is not proof of loss', async () => {
    beginOptimisticSend('sess-1', 'msg-3', 'unknown fate');
    messagesImpl = async () => ({ data: undefined });

    recoverFromSendFailure('sess-1', 'msg-3', new Error('network down'), {
      inboxRowExists: async () => {
        throw new Error('inbox unreachable');
      },
    });
    await tick();
    await tick();

    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-3')).toBe(true);
  });

  test('a billing error keeps the optimistic message, clears busy, and rehydrates from the server', async () => {
    beginOptimisticSend('sess-1', 'msg-1', 'buy me a model');
    messagesImpl = async () => ({
      data: [{ info: { id: 'msg-1', sessionID: 'sess-1', role: 'user' }, parts: [] }],
    });

    const billingError = Object.assign(new Error('Payment Required'), {
      status: 402,
      data: { message: 'Insufficient credits. Balance: $-0.06' },
    });

    useSessionWorkingStore.getState().noteSendReceipt('sess-1', { messageId: 'msg-1', atMs: 1 });

    const classified = recoverFromSendFailure('sess-1', 'msg-1', billingError);

    expect(classified.kind).toBe('billing');
    // An HTTP send failure is NOT evidence the session is idle. A trigger, a
    // second device, or a POST the control plane already accepted can all be
    // running; writing idle into the slot the projection reads as runtime
    // truth unmasked exactly those live turns. Clearing the receipt says the
    // only thing this path knows: nothing is coming for THIS send.
    expect('sess-1' in useSyncStore.getState().sessionStatus).toBe(false);
    expect(useSessionWorkingStore.getState().receipts['sess-1']).toBeUndefined();

    await tick();

    expect(lastMessagesArgs).toEqual({ sessionID: 'sess-1', limit: SESSION_SYNC_PAGE_SIZE });

    // hydrate() ran with the server's echo of the same message — the
    // optimistic entry is superseded, not just deleted outright.
    expect(useSyncStore.getState().messages['sess-1']).toHaveLength(1);
  });

  test('rehydrate fallback removes the optimistic message when the server has no data for it', async () => {
    beginOptimisticSend('sess-1', 'msg-1', 'never made it');
    messagesImpl = async () => ({ data: undefined });

    recoverFromSendFailure('sess-1', 'msg-1', new Error('boom'));
    await tick();

    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-1')).toBe(false);
  });

  test('removes the optimistic message when the rehydrate fetch itself throws', async () => {
    beginOptimisticSend('sess-1', 'msg-1', 'never made it');
    messagesImpl = async () => {
      throw new Error('network down');
    };

    recoverFromSendFailure('sess-1', 'msg-1', new Error('boom'));
    await tick();

    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-1')).toBe(false);
  });

  test('removes the optimistic message outright when the runtime client is not resolvable', () => {
    beginOptimisticSend('sess-1', 'msg-1', 'never made it');
    getClientThrows = new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');

    const classified = recoverFromSendFailure('sess-1', 'msg-1', new Error('boom'));

    expect(classified.kind).toBe('runtime-error');
    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-1')).toBe(false);
  });

  test('uses an injected classifier so a host can layer richer message formatting', () => {
    const classified = recoverFromSendFailure('sess-1', 'msg-1', new Error('raw'), {
      classify: () => ({ kind: 'runtime-error', message: 'formatted by host', cause: null }),
    });
    expect(classified.message).toBe('formatted by host');
  });
});

describe('sendAndRecover', () => {
  test('resolves ok on a successful prompt', async () => {
    promptImpl = async () => ({ data: {} });

    const result = await sendAndRecover({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      parts: [{ type: 'text', text: 'hi' }],
    });

    expect(result).toEqual({ ok: true });
  });

  test('runs recovery and reports the classified error on failure', async () => {
    beginOptimisticSend('sess-1', 'msg-1', 'hi');
    promptImpl = async () => ({
      error: { data: { message: 'Insufficient credits. Balance: $-0.06' } },
      response: new Response(null, { status: 402 }),
    });

    const result = await sendAndRecover({ sessionId: 'sess-1', messageId: 'msg-1', parts: [{ type: 'text', text: 'hi' }] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('billing');
    expect('sess-1' in useSyncStore.getState().sessionStatus).toBe(false);
  });

  test('re-sending one submission keeps its wire messageID, so the proxy still absorbs it', async () => {
    // A host retries a failed send by calling this again with the same queue
    // entry. Without the stable id the second call mints a new `messageID`, the
    // request body differs, and the proxy's body-hash dedupe delivers a prompt
    // that already reached opencode a SECOND time.
    const sent: Array<Record<string, unknown>> = [];
    promptImpl = async (args) => {
      sent.push(args as Record<string, unknown>);
      return { data: {} };
    };
    const submission = {
      sessionId: 'sess-retry',
      messageId: 'msg-1',
      parts: [{ type: 'text' as const, text: 'hi' }],
      clientMessageId: 'cm_42',
    };

    await sendAndRecover(submission);
    await sendAndRecover(submission);

    expect(sent).toHaveLength(2);
    expect(sent[0].messageID).toBeTruthy();
    expect(sent[1].messageID).toBe(sent[0].messageID);
  });

  test('a different submission of the same text still gets its own messageID', async () => {
    const sent: Array<Record<string, unknown>> = [];
    promptImpl = async (args) => {
      sent.push(args as Record<string, unknown>);
      return { data: {} };
    };

    await sendAndRecover({
      sessionId: 'sess-retry',
      messageId: 'msg-1',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_1',
    });
    await sendAndRecover({
      sessionId: 'sess-retry',
      messageId: 'msg-2',
      parts: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'cm_2',
    });

    expect(sent[0].messageID).not.toBe(sent[1].messageID);
  });
});

describe('applyOptimisticAbort', () => {
  test('patches an AbortError onto the last error-free assistant message and writes NO status frame', () => {
    useSyncStore.getState().setStatus('sess-1', { type: 'busy' });
    useSyncStore.getState().upsertMessage('sess-1', { id: 'm1', sessionID: 'sess-1', role: 'user' } as any);
    useSyncStore.getState().upsertMessage('sess-1', { id: 'm2', sessionID: 'sess-1', role: 'assistant' } as any);

    applyOptimisticAbort('sess-1');

    // The optimistic idle FRAME is gone: `noteAbortReceipt` carries the same
    // intent with provenance and a bound (`OPTIMISTIC_ABORT_MAX_MS`), and a
    // fabricated frame outranked the control plane's own `/turn` answer in
    // `projectWorking` — the exact laundering this migration removes. The
    // transcript-side AbortError patch stays: it is a designed optimistic echo
    // about a MESSAGE, not a status.
    expect(useSyncStore.getState().sessionStatus['sess-1']).toEqual({ type: 'busy' });
    const msg2 = useSyncStore.getState().messages['sess-1']?.find((m) => m.id === 'm2') as any;
    expect(msg2.error).toEqual({
      name: 'AbortError',
      data: { message: 'The operation was aborted.', reason: 'user' },
    });
  });

  // T2: `applyOptimisticAbort` is a REAL user stop, distinct from
  // `markSessionAbortedLocally`'s `reason: 'runtime-disposed'` — apps/web
  // renders only `'user'` (and untagged wire aborts) as the "Interrupted"
  // row, and `reason: 'runtime-disposed'` as nothing.
  test('tags the patched error with reason: "user"', () => {
    useSyncStore.getState().upsertMessage('sess-2', { id: 'm1', sessionID: 'sess-2', role: 'assistant' } as any);

    applyOptimisticAbort('sess-2');

    const msg = useSyncStore.getState().messages['sess-2']?.find((m) => m.id === 'm1') as any;
    expect(msg.error.data.reason).toBe('user');
  });

  test('does not overwrite an assistant message that already has an error', () => {
    useSyncStore.getState().upsertMessage('sess-1', {
      id: 'm1',
      sessionID: 'sess-1',
      role: 'assistant',
      error: { name: 'SomeOtherError', data: {} },
    } as any);

    applyOptimisticAbort('sess-1');

    const msg1 = useSyncStore.getState().messages['sess-1']?.find((m) => m.id === 'm1') as any;
    expect(msg1.error.name).toBe('SomeOtherError');
  });

  test('no-ops when the session has no messages yet — and still writes no status', () => {
    expect(() => applyOptimisticAbort('sess-empty')).not.toThrow();
    expect(useSyncStore.getState().sessionStatus['sess-empty']).toBeUndefined();
  });
});

// ============================================================================
// replayStartStash — a manual fake clock (same shape as event-stream.test.ts's)
// lets these tests drive the write-race / readiness-poll timers deterministically.
// ============================================================================

function createFakeTimers(): StashReplayTimers & { runAll: () => Promise<void> } {
  let seq = 0;
  const pending = new Map<number, () => void>();

  const setTimeoutFn: StashReplayTimers['setTimeout'] = (handler) => {
    const id = ++seq;
    pending.set(id, handler);
    return id as unknown as StashReplayTimerHandle;
  };
  const clearTimeoutFn: StashReplayTimers['clearTimeout'] = (handle) => {
    if (handle === undefined) return;
    pending.delete(handle as unknown as number);
  };
  // Runs every timer that gets scheduled, including ones scheduled by a
  // handler that itself just ran — i.e. drains the whole retry/poll chain.
  const runAll = async () => {
    for (let i = 0; i < 5000; i++) {
      const next = pending.entries().next();
      if (next.done) break;
      const [id, fn] = next.value;
      pending.delete(id);
      fn();
      await tick(1);
    }
  };
  return { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, runAll };
}

describe('replayStartStash', () => {
  test('write-race retry finds a stash written just after the first read attempt', async () => {
    const timers = createFakeTimers();
    let sent: unknown;
    const handle = replayStartStash({
      sessionId: 'sess-1',
      timers,
      checkReadiness: () => ({ model: 'kortix/glm-5.2' }),
      prepare: (stash, ready) => ({
        messageId: 'msg-1',
        optimisticText: stash.prompt,
        buildParts: async () => {
          sent = { stash, ready };
          return [{ type: 'text', text: stash.prompt }];
        },
      }),
    });

    // Nothing written yet — first read attempt finds no stash.
    expect(readStartStash('sess-1')).toBeNull();
    // The producer writes it right after (the write-race this retry covers).
    writeStartStash('sess-1', { prompt: 'hello from the new-session screen', model: null, agent: null });

    await timers.runAll();
    await tick();

    expect(sent).toMatchObject({ stash: { prompt: 'hello from the new-session screen' } });
    handle.cancel();
  });

  test('gives up cleanly with no stash ever written (never calls prepare)', async () => {
    const timers = createFakeTimers();
    const prepare = mock(() => {
      throw new Error('should never be called');
    });
    const handle = replayStartStash({
      sessionId: 'sess-empty',
      timers,
      checkReadiness: () => ({}),
      prepare: prepare as any,
    });

    await timers.runAll();
    expect(prepare).not.toHaveBeenCalled();
    handle.cancel();
  });

  test('a readiness-gate timeout abandons cleanly without ever sending, and the stash is left untouched', async () => {
    const timers = createFakeTimers();
    writeStartStash('sess-1', { prompt: 'ready check never passes', model: null, agent: null });
    let timedOut = false;
    const prepare = mock(() => {
      throw new Error('should never be called — readiness never resolves');
    });

    const handle = replayStartStash({
      sessionId: 'sess-1',
      timers,
      readinessAttempts: 3,
      checkReadiness: () => null,
      onReadinessTimeout: () => {
        timedOut = true;
      },
      prepare: prepare as any,
    });

    await timers.runAll();

    expect(timedOut).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    // Never sent, so nothing to restore — the original stash is exactly as
    // the producer left it (this replay never cleared it).
    expect(readStartStash('sess-1')).toMatchObject({ prompt: 'ready check never passes' });
    handle.cancel();
  });

  test('a buildParts failure restores the stash and reports the classified error via onFailure', async () => {
    const timers = createFakeTimers();
    writeStartStash('sess-1', { prompt: 'upload will fail', model: null, agent: null });
    let failure: { error: unknown; classifiedKind: string } | null = null;

    const handle = replayStartStash({
      sessionId: 'sess-1',
      timers,
      checkReadiness: () => ({}),
      prepare: (stash) => ({
        messageId: 'msg-1',
        optimisticText: stash.prompt,
        buildParts: async () => {
          throw new Error('upload failed');
        },
      }),
      onFailure: (_stash, error, classified) => {
        failure = { error, classifiedKind: classified.kind };
      },
    });

    await timers.runAll();
    await tick();

    expect(failure).toMatchObject({ classifiedKind: 'runtime-error' });
    // Stash restored — a later retry (e.g. after the user reloads) can still
    // pick up the original prompt.
    expect(readStartStash('sess-1')).toMatchObject({ prompt: 'upload will fail' });
    // The optimistic message added before the failed build is cleaned up by
    // the shared recovery routine (no server data to rehydrate from).
    await tick();
    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-1')).toBe(false);
    handle.cancel();
  });

  test('a network send failure restores the stash and reports the classified error via onFailure', async () => {
    const timers = createFakeTimers();
    writeStartStash('sess-1', { prompt: 'network will fail', model: null, agent: null });
    // A real 4xx (never retried by `promptOpenCodeMessage`) so this test
    // doesn't ride out that function's own transient-failure backoff, which
    // uses the real clock independently of the `timers` this test controls.
    promptImpl = async () => ({
      error: { message: 'bad request' },
      response: new Response(null, { status: 400 }),
    });
    let failure: { classifiedKind: string } | null = null;

    const handle = replayStartStash({
      sessionId: 'sess-1',
      timers,
      checkReadiness: () => ({}),
      prepare: (stash) => ({
        messageId: 'msg-1',
        optimisticText: stash.prompt,
        buildParts: async () => [{ type: 'text', text: stash.prompt }],
      }),
      onFailure: (_stash, _error, classified) => {
        failure = { classifiedKind: classified.kind };
      },
    });

    await timers.runAll();
    await tick();

    expect(failure).toMatchObject({ classifiedKind: 'runtime-error' });
    expect(readStartStash('sess-1')).toMatchObject({ prompt: 'network will fail' });
    handle.cancel();
  });

  test('reports successful stash delivery so the host can clear its durable draft', async () => {
    const timers = createFakeTimers();
    writeStartStash('sess-1', { prompt: 'durable prompt', model: null, agent: null });
    const delivery = { prompt: null as string | null };

    const handle = replayStartStash({
      sessionId: 'sess-1',
      timers,
      checkReadiness: () => ({}),
      prepare: (stash) => ({
        messageId: 'msg-1',
        optimisticText: stash.prompt,
        buildParts: async () => [{ type: 'text', text: stash.prompt }],
      }),
      onSuccess: (stash) => {
        delivery.prompt = stash.prompt;
      },
    });

    await timers.runAll();
    await tick();

    expect(delivery.prompt).toBe('durable prompt');
    handle.cancel();
  });

  test('cancel() stops a pending write-race retry from ever sending', async () => {
    const timers = createFakeTimers();
    const prepare = mock(() => {
      throw new Error('should never run — cancelled before the stash appears');
    });
    const handle = replayStartStash({
      sessionId: 'sess-1',
      timers,
      checkReadiness: () => ({}),
      prepare: prepare as any,
    });

    handle.cancel();
    writeStartStash('sess-1', { prompt: 'too late', model: null, agent: null });
    await timers.runAll();

    expect(prepare).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The receipts `useSessionSend` files — the abort floor the published hook
// never had.
// ============================================================================

/**
 * `useSessionSend` is the SDK's own "just send this text" hook, and it filed
 * NOTHING into the working store. A consumer combining it with
 * `useSessionWorking` therefore had:
 *
 *  - no send floor: a `/turn` read issued while the POST was still on the wire
 *    honestly answers "no turns" and flipped the composer back to Send
 *    mid-send;
 *  - no abort floor: every `/turn` read inside the ~1.6s cancel round trip
 *    still reports the doomed turn, so Stop flipped straight back on.
 *
 * These are the exact pairings `apps/web` already does by hand
 * (`session-chat.tsx`'s `issueSessionCancel`, `use-session.ts`'s
 * `sendParts`/`cancel`). They live in plain functions, not in the hook body,
 * so the ORDER is asserted rather than inspected.
 */
describe('sendWithReceipt', () => {
  test('notes the receipt BEFORE the send and accepts it only once the server has the prompt', async () => {
    let release!: () => void;
    promptImpl = () =>
      new Promise((resolve) => {
        release = () => resolve({ data: {} });
      });

    const pending = sendWithReceipt({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      parts: [{ type: 'text', text: 'hi' }],
    });
    await tick();

    // On the wire: the receipt exists and is deliberately UNACCEPTED, which is
    // what bars a `/turn` read stamped inside this window from answering.
    expect(useSessionWorkingStore.getState().receipts['sess-1']).toMatchObject({
      messageId: 'msg-1',
      acceptedAtMs: null,
    });

    release();
    await pending;

    expect(useSessionWorkingStore.getState().receipts['sess-1']?.acceptedAtMs).toBeNumber();
  });

  test('a refused send clears its own receipt', async () => {
    promptImpl = async () => ({
      error: { data: { message: 'Insufficient credits. Balance: $-0.06' } },
      response: new Response(null, { status: 402 }),
    });

    const result = await sendWithReceipt({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      parts: [{ type: 'text', text: 'hi' }],
    });

    expect(result.ok).toBe(false);
    expect(useSessionWorkingStore.getState().receipts['sess-1']).toBeUndefined();
  });

  test('the receipt is filed under the working id when it differs from the wire id', async () => {
    // `useSessionWorking` is keyed by the KORTIX session id; the prompt goes to
    // the OpenCode wire id. Filing under the wrong one is filing under nothing.
    await sendWithReceipt({
      sessionId: 'ses_wire',
      workingSessionId: 'kx-session',
      messageId: 'msg-1',
      parts: [{ type: 'text', text: 'hi' }],
    });

    expect(useSessionWorkingStore.getState().receipts['kx-session']).toMatchObject({
      messageId: 'msg-1',
    });
    expect(useSessionWorkingStore.getState().receipts['ses_wire']).toBeUndefined();
  });
});

describe('stopWithReceipt', () => {
  test('notes the abort BEFORE the cancel and settles it on the settlement', async () => {
    let release!: () => void;
    const settlement = stopWithReceipt(
      'sess-1',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await tick();

    // The floor: unsettled, so a `/turn` read taken inside the cancel round
    // trip may not report the turn the cancel is ending.
    expect(useSessionWorkingStore.getState().aborts['sess-1']).toMatchObject({
      settledAtMs: null,
    });

    release();
    expect(await settlement).toEqual({ status: 'aborted' });
    await tick();

    expect(useSessionWorkingStore.getState().aborts['sess-1']?.settledAtMs).toBeNumber();
  });

  test('a failed cancel still settles the receipt — an unanswered stop must not pin idle', async () => {
    const settlement = await stopWithReceipt('sess-1', async () => {
      throw new Error('gateway 502');
    });

    expect(settlement.status).toBe('failed');
    await tick();
    expect(useSessionWorkingStore.getState().aborts['sess-1']?.settledAtMs).toBeNumber();
  });

  test('stopping drops any outstanding send receipt', () => {
    // Nothing is coming for ANY send once the user has pressed Stop, so the
    // unnamed clear is correct here and only here.
    useSessionWorkingStore.getState().noteSendReceipt('sess-1', { messageId: 'msg-1', atMs: 1 });

    void stopWithReceipt('sess-1', async () => {});

    expect(useSessionWorkingStore.getState().receipts['sess-1']).toBeUndefined();
  });

  // A prompt forwarded into a live turn survives the OpenCode-side abort as a
  // persisted-but-unanswered inbox row (see `holdSessionPrompts`'s doc
  // comment) — the reaper redelivers it unless the hold already marked it
  // stop-paused BEFORE the abort ran. These assert the actual pairing and
  // ordering, not just that local bookkeeping fired — the gap the defect
  // named was exactly that the previous test suite never exercised the hold
  // call at all.
  test('holds the prompt inbox BEFORE the abort when projectId is given — mirrors apps/web handleStop', async () => {
    const order: string[] = [];
    let releaseHold!: () => void;
    const holdInboxPrompts = mock((projectId: string, sessionId: string, held: boolean) => {
      order.push(`hold:${projectId}:${sessionId}:${held}`);
      return new Promise<{ prompts: unknown[] }>((resolve) => {
        releaseHold = () => resolve({ prompts: [] });
      });
    });
    const runAbort = mock(async () => {
      order.push('abort');
    });

    const settlementPromise = stopWithReceipt('ses_wire', runAbort, {
      projectId: 'proj-1',
      workingSessionId: 'kx-1',
      holdInboxPrompts,
    });
    await tick();

    // The abort must not have gone out yet — the hold is still pending.
    expect(order).toEqual(['hold:proj-1:kx-1:true']);
    expect(runAbort).not.toHaveBeenCalled();

    releaseHold();
    await settlementPromise;

    expect(order).toEqual(['hold:proj-1:kx-1:true', 'abort']);
  });

  test('holds the KORTIX session id (workingSessionId), never the OpenCode runtime id', async () => {
    let seenSessionId: string | undefined;
    const holdInboxPrompts = mock((_projectId: string, sessionId: string) => {
      seenSessionId = sessionId;
      return Promise.resolve({ prompts: [] });
    });
    await stopWithReceipt('ses_wire', async () => {}, {
      projectId: 'proj-1',
      workingSessionId: 'kx-session',
      holdInboxPrompts,
    });
    expect(seenSessionId).toBe('kx-session');
  });

  test('a failed hold is caught, never rethrown, and does not block the abort', async () => {
    const holdInboxPrompts = mock(async () => {
      throw new Error('network blip');
    });
    const runAbort = mock(async () => {});
    const settlement = await stopWithReceipt('sess-1', runAbort, {
      projectId: 'proj-1',
      holdInboxPrompts,
    });
    expect(runAbort).toHaveBeenCalledTimes(1);
    expect(settlement.status).toBe('aborted');
  });

  test('the hold is bounded — a stalled hold does not delay the abort past holdDeadlineMs', async () => {
    const holdInboxPrompts = mock(() => new Promise<{ prompts: unknown[] }>(() => {})); // never resolves
    const runAbort = mock(async () => {});
    const settlement = await stopWithReceipt('sess-1', runAbort, {
      projectId: 'proj-1',
      holdInboxPrompts,
      holdDeadlineMs: 5,
    });
    expect(runAbort).toHaveBeenCalledTimes(1);
    expect(settlement.status).toBe('aborted');
  });

  test('no projectId — the hold is skipped entirely, matching pre-inbox behavior', async () => {
    const holdInboxPrompts = mock(async () => ({ prompts: [] }));
    const runAbort = mock(async () => {});
    await stopWithReceipt('sess-1', runAbort, { holdInboxPrompts });
    expect(holdInboxPrompts).not.toHaveBeenCalled();
    expect(runAbort).toHaveBeenCalledTimes(1);
  });
});
