/**
 * `resolveProjectComposerState(...).capabilities(...)` — the PRODUCTION path
 * behind `GET /:projectId/composer-capabilities` and session creation
 * (`sessions.ts`) — used to be the real gate site for `experimental_harnesses`
 * (removed 2026-07-22, reversing part of `876742672`: multi-harness is no
 * longer an experiment — OpenCode stays the default a fresh/upgraded project
 * gets, but every declared harness is equally selectable/startable, gate-
 * free). This file is the production-path proof that a non-OpenCode harness's
 * `can_start` now depends ONLY on its own auth/model resolution — never on a
 * feature flag, and never distinguishable from OpenCode's own gate-free
 * behavior.
 *
 * CARRIED FIX (WS2-P1-a review, kept through the 2026-07-22 gate removal):
 * `harness-capability-conformance.test.ts`'s `live_change` block only pins
 * `HARNESSES[id].liveModelChange` against itself (a pre/post-refactor
 * behavior-freeze, explicitly documented there as "no extracted pure function
 * to call directly"). It never calls the actual `capabilities()` closure, so
 * a future edit could silently break the live wiring while that conformance
 * test kept passing. This file closes that gap: the same production-path
 * invocation used below also asserts `model.live_change` for opencode (true)
 * and claude (false).
 *
 * Mocks the three I/O dependencies `resolveProjectComposerState` composes
 * (compiled runtime config, project secrets, repo file listing) so the real
 * closure runs without a live DB/git mirror — mirrors the mock-then-dynamic-
 * import pattern in `compile-agent-config.test.ts`.
 */
import { describe, expect, mock, test } from 'bun:test';
import { HARNESSES } from '@kortix/shared/harnesses';
import type { CompiledRuntimeConfig } from './compile-runtime-config';

let secretsEnv: Record<string, string> = {};

mock.module('../secrets', () => ({
  listProjectSecretsSnapshotForUser: async () => ({
    env: secretsEnv,
    names: Object.keys(secretsEnv),
    revision: 'test-revision',
  }),
  // Stub exports for the rest of `projects/secrets.ts`'s surface — needed
  // because `composer-capabilities.ts` now transitively imports
  // `llm-gateway/resolution/{default-model,resolve-candidates}.ts`, which
  // import these named exports from the SAME module this file mocks (Bun's
  // `mock.module` replaces the module globally for the test run, so every
  // importer sees this replacement). Never actually invoked here: every
  // fixture below omits `accountId`, so `managedGatewayHasNothingToRouteTo`'s
  // `probeServable` short-circuits to "assume servable" without calling
  // `isModelServableForAccount` (see composer-capabilities.ts's doc comment).
  listProjectSecretsSnapshot: async () => ({ env: secretsEnv, names: Object.keys(secretsEnv), revision: 'test-revision' }),
  getProjectSecretValue: async () => null,
  decryptProjectSecret: (_projectId: string, value: string) => value,
  encryptProjectSecret: (_projectId: string, value: string) => value,
}));

mock.module('../git/files', () => ({
  listRepoFiles: async () => [],
}));

mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => false,
}));

// Two agents on distinct harnesses: opencode (the default) and claude (a
// non-default harness, previously gated). Both resolve their auth off the
// same `anthropic_api_key` connection so `can_start` is attributable ONLY to
// each harness's own auth/model resolution, never to unrelated plumbing.
const FIXTURE: CompiledRuntimeConfig = {
  kind: 'acp',
  version: 3,
  defaultAgent: 'opencodeAgent',
  runtimes: {
    opencode: { name: 'opencode', harness: 'opencode', configDir: HARNESSES.opencode.configDir },
    claude: { name: 'claude', harness: 'claude', configDir: HARNESSES.claude.configDir },
  },
  agents: {
    opencodeAgent: {
      name: 'opencodeAgent',
      runtime: 'opencode',
      harness: 'opencode',
      nativeAgent: null,
      enabled: true,
      connectors: 'all',
      secrets: 'all',
      skills: 'all',
      kortixCli: 'none',
      workspace: 'runtime',
    },
    claudeAgent: {
      name: 'claudeAgent',
      runtime: 'claude',
      harness: 'claude',
      nativeAgent: null,
      enabled: true,
      connectors: 'all',
      secrets: 'all',
      skills: 'all',
      kortixCli: 'none',
      workspace: 'runtime',
    },
  },
};

mock.module('./compile-runtime-config', () => ({
  resolveCompiledRuntimeConfigForSession: async () => FIXTURE,
}));

const { resolveProjectComposerState } = await import('./composer-capabilities');

const PROJECT = {
  projectId: 'proj-harness-availability-test',
  repoUrl: 'https://example.test/gate.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

describe('composer-capabilities production path — no harness-selection gate, opencode or otherwise', () => {
  test('claude can start with ready auth, no metadata/opt-in needed; opencode is identically unaffected', async () => {
    secretsEnv = { ANTHROPIC_API_KEY: 'test-key' };
    const state = await resolveProjectComposerState({ project: PROJECT, userId: 'user-1', metadata: {} });

    const claude = await state.capabilities('claudeAgent');
    expect(claude.can_start).toBe(true);
    expect(claude.blocking_reason).toBeNull();
    expect(claude.auth.ready).toBe(true);

    const opencode = await state.capabilities('opencodeAgent');
    expect(opencode.can_start).toBe(true);
    expect(opencode.blocking_reason).toBeNull();
  });

  test('metadata is irrelevant to can_start now — an empty, populated, or garbage experimental map behaves identically', async () => {
    secretsEnv = { ANTHROPIC_API_KEY: 'test-key' };
    for (const metadata of [{}, { experimental: {} }, { experimental: { anything: true } }]) {
      const state = await resolveProjectComposerState({ project: PROJECT, userId: 'user-1', metadata });
      const claude = await state.capabilities('claudeAgent');
      expect(claude.can_start).toBe(true);
    }
  });

  test('claude WITHOUT a compatible credential still fails to start — can_start reflects real auth/model resolution, not a rubber stamp', async () => {
    secretsEnv = {};
    const state = await resolveProjectComposerState({ project: PROJECT, userId: 'user-1', metadata: {} });
    const claude = await state.capabilities('claudeAgent');
    expect(claude.can_start).toBe(false);
    expect(claude.blocking_reason).not.toBeNull();
    // Never the deleted gate's copy — a real auth/credential reason instead.
    expect(claude.blocking_reason).not.toContain('experimental harness');
  });

  test('CARRIED FIX (WS2-P1-a review): capabilities().model.live_change matches HARNESSES[harness].liveModelChange on the production path', async () => {
    secretsEnv = { ANTHROPIC_API_KEY: 'test-key' };
    const state = await resolveProjectComposerState({ project: PROJECT, userId: 'user-1', metadata: {} });

    const opencode = await state.capabilities('opencodeAgent');
    expect(opencode.model.live_change).toBe(HARNESSES.opencode.liveModelChange);
    expect(opencode.model.live_change).toBe(true);

    const claude = await state.capabilities('claudeAgent');
    expect(claude.model.live_change).toBe(HARNESSES.claude.liveModelChange);
    expect(claude.model.live_change).toBe(false);
  });
});
