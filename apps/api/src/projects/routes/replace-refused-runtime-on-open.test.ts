/**
 * Rule 4 of the runtime-convergence contract (PR #7785): "a box that fails
 * admission is replaced, not used." `replaceRefusedRuntimeOnOpen` is the
 * admission-refusal path `runOpenSession` calls instead of
 * `preserveEstablishedRuntimeOnOpen` — the previous wiring parked the session
 * as `stage:'failed'` on refusal, which is the opposite of the contract for a
 * box that is merely unserviceable (e.g. missing a boot-time env var), not
 * lost.
 *
 * Collaborators are injected (same pattern as `admitRunningSandbox`'s and
 * `guaranteeCurrentRuntimeOnOpen`'s `deps` parameter) so this suite never
 * touches a real database, provider, or provisioning pipeline.
 */
import type { sessionSandboxes } from '@kortix/db';
import { describe, expect, test } from 'bun:test';
import { RUNTIME_IDENTITY_UNAVAILABLE } from '../../services/sandboxes/runtime-identity';
import { ADMISSION_REPLACE_MAX_PER_WINDOW, replaceRefusedRuntimeOnOpen } from './shared';

const RUNNING_ROW = {
  sandboxId: 'sess-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  provider: 'daytona',
  externalId: 'ext-1',
  baseUrl: null,
  status: 'active',
  config: {},
  metadata: {},
  lastUsedAt: null,
  deadlineAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
} as unknown as typeof sessionSandboxes.$inferSelect;

const LOADED = { row: {} as never, userId: 'user-1' };
const VISIBLE = {
  row: {
    sandboxProvider: 'daytona',
    baseRef: null,
    agentName: 'default',
    metadata: null,
  },
};
const REASON = 'runtime_admission_refused:catalog_fingerprint';

describe('replaceRefusedRuntimeOnOpen', () => {
  test('a refused RUNNING box is replaced, not parked: provisioning + retriable, never failed', async () => {
    let retireCalledWith: unknown = null;
    let allocateCalled = false;

    const result = await replaceRefusedRuntimeOnOpen(
      LOADED,
      VISIBLE,
      'proj-1',
      'sess-1',
      RUNNING_ROW,
      REASON,
      {
        claimBudget: async () => ({ allowed: true, count: 1 }),
        retire: async (row) => {
          retireCalledWith = row;
          return true;
        },
        allocate: async () => {
          allocateCalled = true;
        },
      },
    );

    expect(retireCalledWith).toBe(RUNNING_ROW);
    expect(allocateCalled).toBe(true);
    expect(result.stage).toBe('provisioning');
    expect(result.retriable).toBe(true);
    expect(result.stage).not.toBe('failed');
    expect(result.reason).not.toBe(RUNTIME_IDENTITY_UNAVAILABLE);
    // The old wiring's terminal payload — the web's "computer was lost" flag —
    // must never appear on a replacement.
    expect((result as { failure?: unknown }).failure).toBeUndefined();
  });

  test('a retire that could not run (live turn / lost claim / stop failure) is a transient miss, not a failure', async () => {
    const result = await replaceRefusedRuntimeOnOpen(
      LOADED,
      VISIBLE,
      'proj-1',
      'sess-1',
      RUNNING_ROW,
      REASON,
      {
        claimBudget: async () => ({ allowed: true, count: 1 }),
        retire: async () => false,
        allocate: async () => {
          throw new Error('must not allocate when retire did not run');
        },
      },
    );

    expect(result.stage).toBe('starting');
    expect(result.retriable).toBe(true);
    expect(result.reason).not.toBe(RUNTIME_IDENTITY_UNAVAILABLE);
  });

  test('a bounded-exhausted session gets a terminal, honestly-labeled failure — never RUNTIME_IDENTITY_UNAVAILABLE', async () => {
    let retireCalled = false;

    const result = await replaceRefusedRuntimeOnOpen(
      LOADED,
      VISIBLE,
      'proj-1',
      'sess-1',
      RUNNING_ROW,
      REASON,
      {
        claimBudget: async () => ({ allowed: false, count: ADMISSION_REPLACE_MAX_PER_WINDOW + 1 }),
        retire: async () => {
          retireCalled = true;
          return true;
        },
        allocate: async () => {
          throw new Error('must not allocate over budget');
        },
      },
    );

    expect(retireCalled).toBe(false);
    expect(result.stage).toBe('failed');
    expect(result.reason).toBe('runtime_admission_replace_exhausted');
    // Bounded ≠ lost. The web keys "computer was lost" off this exact string.
    expect(result.reason).not.toBe(RUNTIME_IDENTITY_UNAVAILABLE);
  });
});
