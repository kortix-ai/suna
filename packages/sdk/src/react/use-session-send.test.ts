import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Mirrors messages.test.ts / use-session.test.ts: stub the lowest network
// boundary (the OpenCode SDK client singleton) so the real send/recovery
// logic under test runs unmodified.
let messagesImpl: (args: { sessionID: string }) => Promise<{ data?: unknown }> = async () => ({
  data: undefined,
});
let promptImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });
let getClientThrows: Error | null = null;

mock.module('../opencode/client', () => ({
  getClient: () => {
    if (getClientThrows) throw getClientThrows;
    return {
      session: {
        messages: (args: { sessionID: string }) => messagesImpl(args),
        promptAsync: (args: unknown) => promptImpl(args),
      },
    };
  },
}));

mock.module('../platform/logger', () => ({
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
  useSyncStore.getState().reset();
});

afterEach(() => {
  delete (globalThis as any).sessionStorage;
});

import { useSyncStore } from '../state/sync-store';
import { readStartStash, writeStartStash } from './session-start-stash';
import {
  abandonOptimisticSend,
  applyOptimisticAbort,
  beginOptimisticSend,
  recoverFromSendFailure,
  replayStartStash,
  sendAndRecover,
  type StashReplayTimerHandle,
  type StashReplayTimers,
} from './use-session-send';

async function tick(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe('beginOptimisticSend', () => {
  test('adds a user message optimistically and flips the session busy', () => {
    beginOptimisticSend('sess-1', 'msg-1', 'hello there', ['prt-1']);

    const msgs = useSyncStore.getState().messages['sess-1'];
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0]).toMatchObject({ id: 'msg-1', role: 'user' });
    expect(useSyncStore.getState().parts['msg-1']?.[0]).toMatchObject({ id: 'prt-1', text: 'hello there' });
    expect(useSyncStore.getState().sessionStatus['sess-1']).toEqual({ type: 'busy' });
  });

  test('adds no parts for empty/whitespace-only text', () => {
    beginOptimisticSend('sess-1', 'msg-1', '   ');
    expect(useSyncStore.getState().parts['msg-1'] ?? []).toHaveLength(0);
  });
});

describe('abandonOptimisticSend', () => {
  test('clears busy and removes the optimistic message', () => {
    beginOptimisticSend('sess-1', 'msg-1', 'hello');
    abandonOptimisticSend('sess-1', 'msg-1');

    expect(useSyncStore.getState().sessionStatus['sess-1']).toEqual({ type: 'idle' });
    expect(useSyncStore.getState().messages['sess-1']?.some((m) => m.id === 'msg-1')).toBe(false);
  });
});

describe('recoverFromSendFailure', () => {
  test('a billing error keeps the optimistic message, clears busy, and rehydrates from the server', async () => {
    beginOptimisticSend('sess-1', 'msg-1', 'buy me a model');
    messagesImpl = async () => ({
      data: [{ info: { id: 'msg-1', sessionID: 'sess-1', role: 'user' }, parts: [] }],
    });

    const billingError = Object.assign(new Error('Payment Required'), {
      status: 402,
      data: { message: 'Insufficient credits. Balance: $-0.06' },
    });

    const classified = recoverFromSendFailure('sess-1', 'msg-1', billingError);

    expect(classified.kind).toBe('billing');
    expect(useSyncStore.getState().sessionStatus['sess-1']).toEqual({ type: 'idle' });

    await tick();

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
    expect(useSyncStore.getState().sessionStatus['sess-1']).toEqual({ type: 'idle' });
  });
});

describe('applyOptimisticAbort', () => {
  test('sets the session idle and patches an AbortError onto the last error-free assistant message', () => {
    useSyncStore.getState().setStatus('sess-1', { type: 'busy' });
    useSyncStore.getState().upsertMessage('sess-1', { id: 'm1', sessionID: 'sess-1', role: 'user' } as any);
    useSyncStore.getState().upsertMessage('sess-1', { id: 'm2', sessionID: 'sess-1', role: 'assistant' } as any);

    applyOptimisticAbort('sess-1');

    expect(useSyncStore.getState().sessionStatus['sess-1']).toEqual({ type: 'idle' });
    const msg2 = useSyncStore.getState().messages['sess-1']?.find((m) => m.id === 'm2') as any;
    expect(msg2.error).toEqual({ name: 'AbortError', data: { message: 'The operation was aborted.' } });
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

  test('no-ops when the session has no messages yet', () => {
    expect(() => applyOptimisticAbort('sess-empty')).not.toThrow();
    expect(useSyncStore.getState().sessionStatus['sess-empty']).toEqual({ type: 'idle' });
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
      checkReadiness: () => ({ model: 'kortix/auto' }),
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
