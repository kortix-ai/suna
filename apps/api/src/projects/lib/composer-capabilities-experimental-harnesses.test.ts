/**
 * `resolveProjectComposerState(...).capabilities(...)` — the PRODUCTION path
 * behind `GET /:projectId/composer-capabilities` and session creation
 * (`sessions.ts`) — is the real gate site for `experimental_harnesses`
 * (Task WS2-P1-b, founder posture: OpenCode is the only non-experimental
 * harness). `isExperimentalHarnessGated`'s own pure-function tests live in
 * `composer-capabilities.test.ts`; this file proves the closure actually
 * WIRES that predicate into `can_start`/`blocking_reason` end to end.
 *
 * CARRIED FIX (WS2-P1-a review): `harness-capability-conformance.test.ts`'s
 * `live_change` block only pins `HARNESSES[id].liveModelChange` against
 * itself (a pre/post-refactor behavior-freeze, explicitly documented there
 * as "no extracted pure function to call directly"). It never calls the
 * actual `capabilities()` closure, so a future edit could silently break the
 * live wiring while that conformance test kept passing. This file closes
 * that gap: the SAME production-path invocation used for the flag-ON test
 * below also asserts `model.live_change` for opencode (true) and claude, an
 * experimental harness (false).
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
}));

mock.module('../git/files', () => ({
  listRepoFiles: async () => [],
}));

mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => false,
}));

// Two agents on distinct harnesses: opencode (the only stable harness — never
// gated) and claude (experimental — gated until the project opts in). Both
// resolve their auth off the same `anthropic_api_key` connection so `can_start`
// differences are attributable ONLY to the experimental-harness gate, not to
// unrelated auth/model plumbing.
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
  projectId: 'proj-experimental-gate-test',
  repoUrl: 'https://example.test/gate.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

describe('composer-capabilities production path — experimental_harnesses gates claude/codex/pi, never opencode', () => {
  test('flag OFF: claude cannot start, with a distinct blocking reason; opencode is completely unaffected', async () => {
    secretsEnv = { ANTHROPIC_API_KEY: 'test-key' };
    const state = await resolveProjectComposerState({ project: PROJECT, userId: 'user-1', metadata: {} });

    const claude = await state.capabilities('claudeAgent');
    expect(claude.can_start).toBe(false);
    expect(claude.blocking_reason).not.toBeNull();
    expect(claude.blocking_reason).toContain('experimental harness');
    // Auth itself IS ready — the gate is the only reason start is blocked,
    // never masked as an auth/model failure.
    expect(claude.auth.ready).toBe(true);

    const opencode = await state.capabilities('opencodeAgent');
    expect(opencode.can_start).toBe(true);
    expect(opencode.blocking_reason).toBeNull();
  });

  test('flag ON: claude reflects its normal auth/model logic — no gating reason', async () => {
    secretsEnv = { ANTHROPIC_API_KEY: 'test-key' };
    const metadata = { experimental: { experimental_harnesses: true } };
    const state = await resolveProjectComposerState({ project: PROJECT, userId: 'user-1', metadata });

    const claude = await state.capabilities('claudeAgent');
    expect(claude.can_start).toBe(true);
    expect(claude.blocking_reason).toBeNull();

    const opencode = await state.capabilities('opencodeAgent');
    expect(opencode.can_start).toBe(true);
  });

  test('CARRIED FIX (WS2-P1-a review): capabilities().model.live_change matches HARNESSES[harness].liveModelChange on the production path', async () => {
    secretsEnv = { ANTHROPIC_API_KEY: 'test-key' };
    const metadata = { experimental: { experimental_harnesses: true } };
    const state = await resolveProjectComposerState({ project: PROJECT, userId: 'user-1', metadata });

    const opencode = await state.capabilities('opencodeAgent');
    expect(opencode.model.live_change).toBe(HARNESSES.opencode.liveModelChange);
    expect(opencode.model.live_change).toBe(true);

    const claude = await state.capabilities('claudeAgent');
    expect(claude.model.live_change).toBe(HARNESSES.claude.liveModelChange);
    expect(claude.model.live_change).toBe(false);
  });
});
