// A prompt that met a DOWN RUNTIME must be kept, re-attempted, and only given
// up on after a bounded number of tries.
//
// The incident (Essentia, 2026-08-26): a queued prompt was delivered while its
// box was unreachable. `deliverWithRetry` answered 'failed', the drain read
// 'failed' as terminal, and the row went `state:failed, attempts:1,
// last_error:"delivery outcome: failed"` — dead-lettered on its FIRST attempt
// and never re-tried when the runtime came back minutes later. The user's
// message survived only because the UI offers a manual retry.
//
// Mocks `../../../shared/db` + `../../../lib/logger` via `mock.module`, which is
// process-global in bun:test — so this file runs in its own invocation, the same
// caveat as dead-letter-marks-session-failed.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let selectedRow: Record<string, unknown> | null = null;
let updateCalls: Array<{ updates: Record<string, unknown> }> = [];
let updateReturns: Array<Record<string, unknown>> = [];
let infoLogs: Array<{ message: string; context?: Record<string, unknown> }> = [];

mock.module('../../../lib/logger', () => ({
  logger: {
    debug: () => {},
    info: (message: string, context?: Record<string, unknown>) => {
      infoLogs.push({ message, context });
    },
    warn: () => {},
    error: () => {},
  },
}));

mock.module('../../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (selectedRow ? [selectedRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (updates: Record<string, unknown>) => ({
        where: () => ({
          then: (resolve: (v: unknown) => void) => {
            updateCalls.push({ updates });
            resolve(undefined);
          },
          returning: async () => {
            updateCalls.push({ updates });
            return updateReturns;
          },
        }),
      }),
    }),
  },
}));

/**
 * Flatten a drizzle SQL fragment to its literal text.
 *
 * The fragments hold column references back to the schema, so they are cyclic —
 * `JSON.stringify` throws. Only the string chunks matter for these assertions.
 */
function sqlText(value: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node == null) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const chunks = (node as { queryChunks?: unknown }).queryChunks;
    if (chunks) {
      walk(chunks, depth + 1);
      return;
    }
    const chunkValue = (node as { value?: unknown }).value;
    if (chunkValue !== undefined) walk(chunkValue, depth + 1);
  };
  walk(value, 0);
  return out.join(' ');
}

const {
  MAX_RUNTIME_UNREACHABLE_RETRIES,
  RUNTIME_UNREACHABLE_REASON,
  parkPromptForUnreachableRuntime,
  reArmRuntimeBlockedPrompts,
  runtimeUnreachableRetries,
} = await import('../store');

beforeEach(() => {
  selectedRow = null;
  updateCalls = [];
  updateReturns = [{ commandId: 'cmd-1' }];
  infoLogs = [];
});

describe('parkPromptForUnreachableRuntime', () => {
  test('the first unreachable attempt parks the row instead of failing it', async () => {
    selectedRow = { payload: { text: 'hi' } };

    const outcome = await parkPromptForUnreachableRuntime('cmd-1', 'delivery outcome: unreachable', {
      sessionId: 'sess-1',
      now: new Date('2026-08-26T10:00:00.000Z'),
    });

    expect(outcome).toEqual({ parked: true, retries: 1 });
    expect(updateCalls).toHaveLength(1);
    const updates = updateCalls[0]!.updates;
    // Still QUEUED. `dead_lettered` is what lost the message.
    expect(updates.status).toBe('queued');
    expect(updates.result).toMatchObject({
      delivery_blocked: RUNTIME_UNREACHABLE_REASON,
      runtime_retries: 1,
    });
    // A sleeping box is not the prompt failing, so the claim's increment is
    // handed back: this must never spend the dead-letter budget.
    expect(sqlText(updates.attempts)).toContain('GREATEST');
    // Minutes, not the 2 s ladder — polling a stopped box every 2 s finds it stopped.
    expect((updates.availableAt as Date).getTime()).toBe(
      new Date('2026-08-26T10:00:30.000Z').getTime(),
    );
  });

  test('each park backs off further', async () => {
    const now = new Date('2026-08-26T10:00:00.000Z');
    const dueAfter = async (spent: number) => {
      updateCalls = [];
      selectedRow = { payload: { runtimeUnreachableRetries: spent } };
      await parkPromptForUnreachableRuntime('cmd-1', 'x', { now });
      return (updateCalls[0]!.updates.availableAt as Date).getTime() - now.getTime();
    };
    expect(await dueAfter(0)).toBe(30_000);
    expect(await dueAfter(1)).toBe(120_000);
    expect(await dueAfter(2)).toBe(480_000);
  });

  test('the budget is bounded — the last attempt refuses to park', async () => {
    selectedRow = { payload: { runtimeUnreachableRetries: MAX_RUNTIME_UNREACHABLE_RETRIES } };

    const outcome = await parkPromptForUnreachableRuntime('cmd-1', 'x', { sessionId: 'sess-1' });

    expect(outcome).toEqual({ parked: false, retries: MAX_RUNTIME_UNREACHABLE_RETRIES });
    // Nothing written: the caller dead-letters through markCommandFailed, which
    // owns the alerting and the session-park policy.
    expect(updateCalls).toHaveLength(0);
  });

  test('the next attempt carries a FRESH idempotency key', async () => {
    selectedRow = { payload: {} };
    await parkPromptForUnreachableRuntime('cmd-1', 'x', {});
    // `withNextDeliveryAttempt` bumps payload.deliveryAttempt, which is what
    // makes the re-POST key `<commandId>:rN`. Without it the proxy's 10-minute
    // dedupe claim from the failed POST swallows every re-attempt inside the
    // backoff window and the row closes having delivered nothing.
    expect(sqlText(updateCalls[0]!.updates.payload)).toContain('deliveryAttempt');
    expect(sqlText(updateCalls[0]!.updates.payload)).toContain('runtimeUnreachableRetries');
  });

  test('a Stop that landed during delivery survives the park as a HOLD', async () => {
    selectedRow = { payload: { stopPausedOnDelivery: 'true' } };

    await parkPromptForUnreachableRuntime('cmd-1', 'x', {});

    expect(updateCalls[0]!.updates.result).toMatchObject({
      delivery_blocked: RUNTIME_UNREACHABLE_REASON,
      held: true,
      stop_paused: true,
    });
    // Consumed here, exactly as markCommandForwarded consumes it — otherwise it
    // re-lands on every later delivery of the same row.
    expect(sqlText(updateCalls[0]!.updates.payload)).toContain('stopPausedOnDelivery');
  });

  test('a row that vanished is not parked', async () => {
    selectedRow = null;
    expect(await parkPromptForUnreachableRuntime('cmd-1', 'x', {})).toEqual({
      parked: false,
      retries: 0,
    });
    expect(updateCalls).toHaveLength(0);
  });

  test('a lost UPDATE race (row already dead-lettered) reports not-parked', async () => {
    selectedRow = { payload: {} };
    updateReturns = [];
    expect(await parkPromptForUnreachableRuntime('cmd-1', 'x', {})).toEqual({
      parked: false,
      retries: 0,
    });
  });
});

describe('runtimeUnreachableRetries', () => {
  test('reads the counter and treats anything else as zero', () => {
    expect(runtimeUnreachableRetries({ runtimeUnreachableRetries: 2 })).toBe(2);
    expect(runtimeUnreachableRetries({ runtimeUnreachableRetries: 'two' })).toBe(0);
    expect(runtimeUnreachableRetries(null)).toBe(0);
    expect(runtimeUnreachableRetries({})).toBe(0);
  });
});

describe('reArmRuntimeBlockedPrompts', () => {
  test('a runtime coming back makes its parked prompts due now', async () => {
    updateReturns = [{ commandId: 'cmd-1' }, { commandId: 'cmd-2' }];
    const now = new Date('2026-08-26T11:00:00.000Z');

    expect(await reArmRuntimeBlockedPrompts('sess-1', now)).toBe(2);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.updates.availableAt).toBe(now);
    expect(infoLogs.some((l) => l.message.includes('re-arming'))).toBe(true);
  });

  test('a session with nothing parked writes nothing loud', async () => {
    updateReturns = [];
    expect(await reArmRuntimeBlockedPrompts('sess-1')).toBe(0);
    expect(infoLogs).toHaveLength(0);
  });
});
