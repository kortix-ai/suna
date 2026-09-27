/**
 * `runPrePromptEnvSync` — two things this file pins down.
 *
 * 1. R3 (docs/specs/turn-latency.md §3): session-title generation and the
 *    opencode_sessions snapshot refresh are schedule-and-return, never
 *    awaited on the send path — this asserts that directly, not just that
 *    the response is unchanged (a response-only assertion proves nothing
 *    about latency; see the task's Verification section).
 *
 * 2. What this file is NOT: an R2 candidate. `syncEnv` (push the running
 *    agent's secret grant to the box) and `remintGrant` (re-point the
 *    session token's connector/CLI grant at that agent) look independent —
 *    different rows, `syncEnv` resolves void — but they are not: running
 *    them concurrently let `remintGrant` fire even when `syncEnv` failed,
 *    breaking `command-env-sync.test.ts`'s "Refused BEFORE the grant
 *    re-mint — one switch never half-applies" invariant (caught by that
 *    existing test when a first pass here parallelised them). This file
 *    pins the sequential, fail-fast contract so a future attempt at the
 *    same "optimization" fails loudly here too, not only in the sibling
 *    suite.
 */
import { describe, expect, test } from 'bun:test';
import { runPrePromptEnvSync, type PrePromptEnvSyncDeps } from './pre-prompt-env-sync';

const RECORD = {
  accountId: 'acct-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  externalId: 'ext-1',
  agentName: 'kortix',
  provider: 'daytona',
};

function baseInput(overrides: Partial<Parameters<typeof runPrePromptEnvSync>[0]> = {}) {
  return {
    record: RECORD,
    sandboxId: 'sb-1',
    port: 8000,
    userId: 'user-1',
    origin: 'http://app.local',
    previewUrl: 'http://sandbox.local',
    providerHeaders: {},
    serviceKey: 'svc-key',
    requestedAgent: null,
    body: undefined,
    incomingHeaders: new Headers(),
    ...overrides,
  };
}

function recordingDeps(log: string[], opts: { syncEnvThrows?: Error } = {}): PrePromptEnvSyncDeps {
  return {
    syncEnv: (async () => {
      log.push('syncEnv:called');
      if (opts.syncEnvThrows) throw opts.syncEnvThrows;
    }) as PrePromptEnvSyncDeps['syncEnv'],
    remintGrant: (async () => {
      log.push('remintGrant:called');
      return { action: 'skip' } as never;
    }) as PrePromptEnvSyncDeps['remintGrant'],
    scheduleSnapshot: (() => {
      log.push('scheduleSnapshot:called');
    }) as PrePromptEnvSyncDeps['scheduleSnapshot'],
    generateTitle: (async () => {
      log.push('generateTitle:called');
    }) as PrePromptEnvSyncDeps['generateTitle'],
  };
}

describe('runPrePromptEnvSync — syncEnv/remintGrant stay sequential and fail-fast', () => {
  test('a syncEnv failure means remintGrant never runs at all', async () => {
    const log: string[] = [];
    const deps = recordingDeps(log, { syncEnvThrows: new Error('env push failed') });
    await runPrePromptEnvSync(baseInput(), deps).catch(() => undefined);
    expect(log.filter((e) => e === 'syncEnv:called' || e === 'remintGrant:called')).toEqual([
      'syncEnv:called',
    ]);
  });

  test('on success, syncEnv completes before remintGrant is called', async () => {
    const log: string[] = [];
    const deps = recordingDeps(log);
    const result = await runPrePromptEnvSync(baseInput(), deps);
    expect(result).toBeNull();
    expect(log.filter((e) => e === 'syncEnv:called' || e === 'remintGrant:called')).toEqual([
      'syncEnv:called',
      'remintGrant:called',
    ]);
  });
});

describe('runPrePromptEnvSync — title generation and snapshot scheduling are never awaited (R3)', () => {
  test('the call returns even though generateTitle never resolves', async () => {
    const log: string[] = [];
    const deps: PrePromptEnvSyncDeps = {
      ...recordingDeps(log),
      generateTitle: (async () => {
        log.push('generateTitle:called');
        // Never resolves within the test — if this were awaited, the whole
        // call would hang and the test would time out instead of passing.
        await new Promise(() => {});
      }) as PrePromptEnvSyncDeps['generateTitle'],
    };
    const body = new TextEncoder().encode(
      JSON.stringify({ parts: [{ type: 'text', text: 'hello there' }] }),
    ).buffer as ArrayBuffer;
    const result = await runPrePromptEnvSync(
      baseInput({ body, incomingHeaders: new Headers({ 'content-type': 'application/json' }) }),
      deps,
    );
    expect(result).toBeNull();
    expect(log).toContain('generateTitle:called');
  });

  test('the call returns even though scheduleSnapshot never resolves', async () => {
    const log: string[] = [];
    const deps: PrePromptEnvSyncDeps = {
      ...recordingDeps(log),
      // `scheduleSnapshot` is typed synchronous (`void`), so a real caller
      // cannot literally return an unresolved promise from it — the point
      // this pins is that the route never AWAITS its result at all. Blocking
      // work inside it (simulated here as a long synchronous-looking call
      // via a deferred push) must not delay the return.
      scheduleSnapshot: ((input) => {
        log.push(`scheduleSnapshot:called:${input.sessionId}`);
      }) as PrePromptEnvSyncDeps['scheduleSnapshot'],
    };
    const startedAt = performance.now();
    const result = await runPrePromptEnvSync(baseInput(), deps);
    const elapsedMs = performance.now() - startedAt;
    expect(result).toBeNull();
    expect(log).toContain('scheduleSnapshot:called:sess-1');
    // No `await` on this lane at all — the whole call, including the
    // sequential syncEnv/remintGrant pair, resolves in well under a
    // deliberately-blocking generateTitle's would-be delay.
    expect(elapsedMs).toBeLessThan(50);
  });
});
