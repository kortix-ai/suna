/**
 * The pure half of the open-path retired-model repair.
 *
 * `repairRetiredSessionModelOnOpen` itself is IO all the way down (gateway
 * flag, entitlements, the re-point write, the daemon push), so what is pinned
 * here is the predicate that decides whether ANY of that IO happens — the one
 * thing every healthy session open executes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

import { pinNeedsRepair, storedPinWireId } from './session-model-repair';

describe('storedPinWireId', () => {
  test('strips the synthetic kortix/ provider prefix', () => {
    expect(storedPinWireId({ opencode_model: 'kortix/deepseek-v4-flash' })).toBe(
      'deepseek-v4-flash',
    );
  });

  test('leaves a bare id alone', () => {
    expect(storedPinWireId({ opencode_model: 'deepseek-v4-flash' })).toBe('deepseek-v4-flash');
  });

  test('is null for a session with no pin', () => {
    expect(storedPinWireId({})).toBeNull();
    expect(storedPinWireId(null)).toBeNull();
    expect(storedPinWireId({ opencode_model: '' })).toBeNull();
    expect(storedPinWireId({ opencode_model: 42 })).toBeNull();
  });
});

describe('pinNeedsRepair', () => {
  // The two shapes measured on a real project, 2026-09-28: 88 sessions on a
  // retired id WITH a successor, 20 on a retired id with none. Both are dead
  // turns, so both must be repaired.
  test.each([
    ['kortix/deepseek-v4-flash', 'retired, has a declared successor'],
    ['kortix/glm-5.2', 'retired, no declared successor'],
    ['kortix/grok-4.6', 'retired, no declared successor'],
  ])('%s is repaired (%s)', (pin) => {
    expect(pinNeedsRepair({ opencode_model: pin })).toBe(true);
  });

  test('a servable managed pin is left alone', () => {
    expect(pinNeedsRepair({ opencode_model: 'kortix/deepseek-v4.1-flash' })).toBe(false);
  });

  test('a BYOK ref is left alone', () => {
    expect(pinNeedsRepair({ opencode_model: 'anthropic/claude-sonnet-5' })).toBe(false);
    expect(pinNeedsRepair({ opencode_model: 'kortix/openrouter/z-ai/glm-5.3-flash' })).toBe(false);
  });

  test('a session with no pin is left alone — the fast path', () => {
    expect(pinNeedsRepair(null)).toBe(false);
    expect(pinNeedsRepair({})).toBe(false);
  });
});

/**
 * The KRTX-2213 prod pattern (2026-10-12..15, 704 warn lines on
 * `POST .../sessions/:id/start`): the open-path repair AWAITED its model push
 * on the request path with the daemon transport's full 15 s timeout, so a
 * /start whose box had just become (or was believed) ready paid up to 15 s of
 * dead wait — whole requests of ~15.1 s with the timeout warn inside them —
 * and one warn per affected open.
 *
 * The push is best-effort BY DESIGN (`pushSessionModelToSandbox`: "a sandbox
 * that is down or unreachable simply picks the new model up on its next
 * boot", and the turn-level `model_retired` error remains the fallback), so
 * the open must not wait for it. These tests pin that: the repair resolves
 * while the push is still in flight, the settled outcome is logged, and a
 * push that later fails never surfaces through the open.
 */
describe('repairRetiredSessionModelOnOpen — the model push never blocks the open', () => {
  let settlePush: ((result: { applied: boolean; reason?: string }) => void) | null = null;
  let failPush: ((error: Error) => void) | null = null;
  const logged: Array<{ level: string; msg: string }> = [];

  /** A fresh deferred per push call, so each test controls its own push and a
   *  settled gate never poisons the next case. */
  function nextPushGate(): Promise<{ applied: boolean; reason?: string }> {
    return new Promise((resolve, reject) => {
      settlePush = resolve;
      failPush = reject;
    });
  }

  beforeAll(() => {
    mock.module('../../llm-gateway/enablement', () => ({
      projectLlmGatewayEnabledById: async () => true,
    }));
    mock.module('../../llm-gateway/resolution/session-model-repoint', () => ({
      repointRetiredSessionModel: async () => 'kortix/deepseek-v4.1-flash',
    }));
    mock.module('../../billing/services/entitlements', () => ({
      accountMayUseManagedModels: async () => true,
    }));
    mock.module('./sandbox-env-sync', () => ({
      pushSessionModelToSandbox: () => nextPushGate(),
    }));
    mock.module('../../lib/logger', () => ({
      logger: {
        info: (msg: string) => logged.push({ level: 'info', msg }),
        warn: (msg: string) => logged.push({ level: 'warn', msg }),
        error: (msg: string) => logged.push({ level: 'error', msg }),
      },
    }));
  });

  afterEach(() => {
    // Settle whatever push a test left in flight so nothing leaks into the
    // next case (an unresolved deferred would hang a later drain).
    settlePush?.({ applied: false, reason: 'test cleanup' });
    logged.length = 0;
  });

  afterAll(() => {
    failPush = null;
    settlePush = null;
  });

  async function repair(): Promise<{ repointed: string | null }> {
    // Fresh import AFTER mock.module so the repair sees the mocks above
    // (same pattern as the sibling env-sync suites).
    const { repairRetiredSessionModelOnOpen } = await import('./session-model-repair');
    return repairRetiredSessionModelOnOpen({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      accountId: 'acct-1',
      userId: 'user-1',
      agentName: null,
      metadata: { opencode_model: 'kortix/deepseek-v4-flash' },
    });
  }

  test('the repair resolves while the push is still in flight', async () => {
    const pending = repair();
    const settled = await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);
    expect(settled).toBe('settled');

    // The result says what the open knows at return time: the re-point landed,
    // the push has not settled yet.
    const result = await pending;
    expect(result.repointed).toBe('kortix/deepseek-v4.1-flash');

    settlePush!({ applied: true });
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the detached handler log
    expect(logged.some((l) => l.msg.includes('repaired a retired session model on open'))).toBe(true);
  });

  test('a push that fails later never surfaces through the open and is logged', async () => {
    const result = await repair();
    expect(result.repointed).toBe('kortix/deepseek-v4.1-flash');

    failPush!(new Error('env sync failed: 502 upstream unreachable: Failed to connect'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logged.some((l) => l.level === 'warn')).toBe(true);
  });
});
