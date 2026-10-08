/**
 * `runPrePromptEnvSync` — two things this file pins down.
 *
 * 1. R3 (the turn-latency spec (PR #7840) §3): session-title generation and the
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
import { isRetryableEnvSyncFailure, runPrePromptEnvSync, type PrePromptEnvSyncDeps } from './pre-prompt-env-sync';

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
    bindTurnIdentity: false,
    body: undefined,
    incomingHeaders: new Headers(),
    ...overrides,
  };
}

function recordingDeps(
  log: string[],
  opts: { syncEnvThrows?: Error; bindThrows?: Error } = {},
): PrePromptEnvSyncDeps {
  return {
    syncEnv: (async () => {
      log.push('syncEnv:called');
      if (opts.syncEnvThrows) throw opts.syncEnvThrows;
    }) as PrePromptEnvSyncDeps['syncEnv'],
    remintGrant: (async () => {
      log.push('remintGrant:called');
      return { action: 'skip' } as never;
    }) as PrePromptEnvSyncDeps['remintGrant'],
    bindTurnIdentity: (async (input) => {
      log.push(`bindTurnIdentity:${input.sessionId}:${input.prompterUserId}`);
      if (opts.bindThrows) throw opts.bindThrows;
      return true;
    }) as PrePromptEnvSyncDeps['bindTurnIdentity'],
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

  // R7.4: the prompt no longer schedules a session-list snapshot. The list
  // follows every stored projection and the turn end, never a prompt timer.
  test('a prompt schedules no deferred session-list snapshot', async () => {
    const log: string[] = [];
    expect(await runPrePromptEnvSync(baseInput(), recordingDeps(log))).toBeNull();
    expect(log.some((entry) => entry.toLowerCase().includes('snapshot'))).toBe(false);
  });
});

describe('runPrePromptEnvSync — a person starting a turn binds the session token to them', () => {
  test('bindTurnIdentity true: the prompter is bound for this session before the turn is forwarded', async () => {
    const log: string[] = [];
    const result = await runPrePromptEnvSync(baseInput({ bindTurnIdentity: true }), recordingDeps(log));
    expect(result).toBeNull();
    expect(log).toContain('bindTurnIdentity:sess-1:user-1');
  });

  test('bindTurnIdentity false (sandbox-authored or server delivery): identity is left alone', async () => {
    const log: string[] = [];
    await runPrePromptEnvSync(baseInput(), recordingDeps(log));
    expect(log.some((e) => e.startsWith('bindTurnIdentity'))).toBe(false);
  });

  test('a failed bind refuses the turn: it never runs as the previous prompter', async () => {
    const log: string[] = [];
    const result = await runPrePromptEnvSync(
      baseInput({ bindTurnIdentity: true }),
      recordingDeps(log, { bindThrows: new Error('db down') }),
    );
    expect(result?.status).toBe(502);
    expect(await result?.json()).toEqual({ error: 'could not bind the session to the person starting this turn' });
    expect(log).not.toContain('remintGrant:called');
  });
});

describe('isRetryableEnvSyncFailure — status and error class, never the body text', () => {
  const httpError = (status: number, body: string) =>
    Object.assign(new Error(`env sync failed: ${status} ${body}`), { name: 'EnvSyncHttpError', status });

  test('a 502/503/504 from the daemon and a fetch that never connected retry', () => {
    for (const status of [502, 503, 504]) expect(isRetryableEnvSyncFailure(httpError(status, ''))).toBe(true);
    expect(isRetryableEnvSyncFailure(Object.assign(new TypeError('Unable to connect'), { code: 'ConnectionRefused' }))).toBe(true);
    expect(isRetryableEnvSyncFailure(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))).toBe(true);
  });

  test('any other daemon status refuses, even when its body mentions a connection failure', () => {
    expect(isRetryableEnvSyncFailure(httpError(500, 'connection refused upstream'))).toBe(false);
    expect(isRetryableEnvSyncFailure(httpError(401, 'timeout'))).toBe(false);
    expect(isRetryableEnvSyncFailure(new Error('socket hang up: econnreset'))).toBe(false);
  });
});
