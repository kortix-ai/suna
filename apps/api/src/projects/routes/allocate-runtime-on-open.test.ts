/**
 * allocateRuntimeOnOpen() (./shared.ts) — the runtime-allocation call site
 * hit by openSession()'s "no usable box" branch (session open/resume) and by
 * the admin sandbox-migrate route (admin/index.ts). WS2-P2-a (65fc39482)
 * fixed a dual-read gap here: this function used to read ONLY
 * `session.metadata?.model`, so a pre-rename persisted session row carrying
 * just the legacy `opencode_model` key resolved to a null runtime model on
 * this path — even though the sibling restart path
 * (`session-lifecycle/actions.ts`) and `model-preferences.ts` already
 * dual-read correctly. The fix delegates to the shared
 * `resolveSessionMetadataModel()` helper (`../lib/session-metadata.ts`,
 * itself unit-tested in `session-metadata.test.ts`) — but nothing exercised
 * the WIRING at this call site specifically (the P2-a e2e test only covers
 * the restart path through `actions.ts`, a different call site). This file
 * pins that: a legacy-only-metadata session must still reach
 * `buildSessionSandboxEnvVars({ runtimeModel })` with the resolved model.
 *
 * Every dependency of `allocateRuntimeOnOpen` besides `resolveSessionMetadataModel`
 * (the code under test) is stubbed — config, db, the runtime allocator, and
 * the env-var builder — so this exercises the REAL call-site wiring in
 * shared.ts, not a reimplementation of it. Mock-before-dynamic-import,
 * mirroring `agent-config-runtime-profiles-gate.test.ts` and
 * `session-lifecycle/__tests__/continue-session-deleted-guard.test.ts`.
 * `mock.module` is process-global — this file must run in its own Bun
 * process, which the sanctioned `pnpm --filter kortix-api test` already
 * guarantees (`scripts/test.sh` isolates each file).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let updateCalls: Array<{ updates: Record<string, unknown> }> = [];
let allocateInput: { buildEnvVars: () => Promise<Record<string, string>> } | null = null;
let buildEnvVarsCalls: Array<{ runtimeModel?: string | null }> = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    update: () => ({
      set: (updates: Record<string, unknown>) => ({
        where: async () => {
          updateCalls.push({ updates });
        },
      }),
    }),
  },
}));

const realSessionsLib = await import('../lib/sessions');
mock.module('../lib/sessions', () => ({
  ...realSessionsLib,
  sandboxCallbackUnreachableReason: () => null,
  buildSessionSandboxEnvVars: async (input: { runtimeModel?: string | null }) => {
    buildEnvVarsCalls.push(input);
    return {};
  },
}));

mock.module('../lib/session-runtime-allocator', () => ({
  allocateSessionRuntime: (input: { buildEnvVars: () => Promise<Record<string, string>> }) => {
    allocateInput = input;
  },
}));

const { allocateRuntimeOnOpen } = await import('./shared');

const LOADED = {
  row: {
    accountId: 'acct-1',
    repoUrl: 'https://example.test/repo.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    metadata: {},
  } as never,
  userId: 'user-1',
};

beforeEach(() => {
  updateCalls = [];
  allocateInput = null;
  buildEnvVarsCalls = [];
});

describe('allocateRuntimeOnOpen — legacy-metadata dual-read at the call site', () => {
  test('a pre-rename session (opencode_model-only metadata) resolves the model through to buildSessionSandboxEnvVars', async () => {
    await allocateRuntimeOnOpen(
      LOADED,
      {
        sandboxProvider: 'daytona',
        baseRef: 'main',
        agentName: 'default',
        metadata: { opencode_model: 'anthropic/claude-opus-4-8' },
      },
      'proj-1',
      'sess-1',
    );

    expect(updateCalls).toHaveLength(1);
    expect(allocateInput).not.toBeNull();
    // The closure is only invoked lazily by the (mocked) allocator — call it
    // ourselves to observe what allocateRuntimeOnOpen actually resolved.
    await allocateInput!.buildEnvVars();

    expect(buildEnvVarsCalls).toHaveLength(1);
    expect(buildEnvVarsCalls[0].runtimeModel).toBe('anthropic/claude-opus-4-8');
  });
});
