/**
 * A harness's native config DIRECTORY existing is not a credential.
 *
 * `@kortix/starter`'s `addNativeHarnessSkillLinks` seeds `.claude/skills`,
 * `.codex/skills` and `.pi/skills` as symlinks into OpenCode's canonical
 * skills tree, so every project created from the default template
 * (`general-knowledge-worker`) carries all four harness config directories
 * from its first commit. `native_config` is a compatible auth kind for every
 * harness, so a presence-only check ("does any repo path start with
 * `.claude/`?") made all of them read as CONFIGURED with zero credentials —
 * and since Claude/Codex own their default model (`ownsDefaultModel: true`),
 * `resolveHarnessModels` short-circuited to `state: 'ready'` before it ever
 * looked for one. `can_start` came back `true`, so the composer's connect
 * gate (`ModelConnectionBar`) never rendered and the user was handed a
 * sendable composer with nothing behind it.
 *
 * `composer-capabilities-harness-availability.test.ts` cannot catch this: it
 * mocks `listRepoFiles` to `[]`, an empty repo that no real project ever is.
 * This file pins the REAL seeded tree.
 *
 * Same mock-then-dynamic-import shape as that file — the three I/O
 * dependencies `resolveProjectComposerState` composes are stubbed so the real
 * closure runs without a DB or git mirror.
 */
import { describe, expect, mock, test } from 'bun:test';
import { HARNESSES } from '@kortix/shared/harnesses';
import type { CompiledRuntimeConfig } from './compile-runtime-config';

let secretsEnv: Record<string, string> = {};
let repoFiles: { path: string; type: 'file'; size: null }[] = [];

mock.module('../secrets', () => ({
  listProjectSecretsSnapshotForUser: async () => ({
    env: secretsEnv,
    names: Object.keys(secretsEnv),
    revision: 'test-revision',
  }),
  listProjectSecretsSnapshot: async () => ({
    env: secretsEnv,
    names: Object.keys(secretsEnv),
    revision: 'test-revision',
  }),
  getProjectSecretValue: async () => null,
  decryptProjectSecret: (_projectId: string, value: string) => value,
  encryptProjectSecret: (_projectId: string, value: string) => value,
}));

mock.module('../git/files', () => ({
  listRepoFiles: async () => repoFiles,
}));

mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => false,
}));

const FIXTURE: CompiledRuntimeConfig = {
  kind: 'acp',
  version: 3,
  defaultAgent: 'opencodeAgent',
  runtimes: {
    opencode: { name: 'opencode', harness: 'opencode', configDir: HARNESSES.opencode.configDir },
    claude: { name: 'claude', harness: 'claude', configDir: HARNESSES.claude.configDir },
    codex: { name: 'codex', harness: 'codex', configDir: HARNESSES.codex.configDir },
    pi: { name: 'pi', harness: 'pi', configDir: HARNESSES.pi.configDir },
  },
  agents: {
    opencodeAgent: agent('opencodeAgent', 'opencode'),
    claudeAgent: agent('claudeAgent', 'claude'),
    codexAgent: agent('codexAgent', 'codex'),
    piAgent: agent('piAgent', 'pi'),
  },
};

function agent(name: string, runtime: 'opencode' | 'claude' | 'codex' | 'pi') {
  return {
    name,
    runtime,
    harness: runtime,
    nativeAgent: null,
    enabled: true,
    connectors: 'all',
    secrets: 'all',
    skills: 'all',
    kortixCli: 'none',
    workspace: 'runtime',
  } as CompiledRuntimeConfig['agents'][string];
}

mock.module('./compile-runtime-config', () => ({
  resolveCompiledRuntimeConfigForSession: async () => FIXTURE,
}));

const { harnessNativeConfigPresent, resolveProjectComposerState } = await import(
  './composer-capabilities'
);

const PROJECT = {
  projectId: 'proj-native-config-test',
  repoUrl: 'https://example.test/seeded.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

function file(path: string) {
  return { path, type: 'file' as const, size: null };
}

/** What `@kortix/starter` actually commits into a default new project. */
const SEEDED_TREE = [
  file('kortix.yaml'),
  file('AGENTS.md'),
  file('.opencode/opencode.jsonc'),
  file('.opencode/agents/kortix.md'),
  file('.opencode/skills/coding/SKILL.md'),
  // `addNativeHarnessSkillLinks` — mode 120000 symlinks into the tree above.
  // `listRepoFiles` reports them as plain blob paths, indistinguishable from
  // a real config file by path prefix alone.
  file('.claude/skills'),
  file('.codex/skills'),
  file('.pi/skills'),
];

describe('harnessNativeConfigPresent — content under a config dir is not a credential', () => {
  test('a seeded skills symlink alone does NOT make a harness native-config ready', () => {
    for (const harness of ['claude', 'codex', 'pi'] as const) {
      expect(
        harnessNativeConfigPresent({
          harness,
          configDir: HARNESSES[harness].configDir,
          files: SEEDED_TREE,
        }),
      ).toBe(false);
    }
  });

  test('a real committed harness config file DOES', () => {
    expect(
      harnessNativeConfigPresent({
        harness: 'claude',
        configDir: '.claude',
        files: [...SEEDED_TREE, file('.claude/settings.json')],
      }),
    ).toBe(true);
    expect(
      harnessNativeConfigPresent({
        harness: 'codex',
        configDir: '.codex',
        files: [...SEEDED_TREE, file('.codex/config.toml')],
      }),
    ).toBe(true);
    // The base starter template genuinely commits OpenCode's own config —
    // opencode's native_config answer must be unchanged by this fix.
    expect(
      harnessNativeConfigPresent({
        harness: 'opencode',
        configDir: '.opencode',
        files: SEEDED_TREE,
      }),
    ).toBe(true);
  });

  test('agent/skill content nested under the config dir never counts', () => {
    expect(
      harnessNativeConfigPresent({
        harness: 'claude',
        configDir: '.claude',
        files: [file('.claude/agents/reviewer.md'), file('.claude/commands/ship.md')],
      }),
    ).toBe(false);
  });
});

describe('production path — a freshly seeded project blocks Claude Code/Codex until connected', () => {
  test('claude with no credentials cannot start, and says how to fix it', async () => {
    secretsEnv = {};
    repoFiles = SEEDED_TREE;
    const state = await resolveProjectComposerState({
      project: PROJECT,
      userId: 'user-1',
      metadata: {},
    });

    const claude = await state.capabilities('claudeAgent');
    expect(claude.can_start).toBe(false);
    expect(claude.auth.ready).toBe(false);
    expect(claude.auth.active).toBeNull();
    expect(claude.model.state).toBe('no_credential');
    expect(claude.blocking_reason).toContain('Claude Code');
  });

  test('codex with no credentials cannot start either', async () => {
    secretsEnv = {};
    repoFiles = SEEDED_TREE;
    const state = await resolveProjectComposerState({
      project: PROJECT,
      userId: 'user-1',
      metadata: {},
    });

    const codex = await state.capabilities('codexAgent');
    expect(codex.can_start).toBe(false);
    expect(codex.auth.ready).toBe(false);
    expect(codex.model.state).toBe('no_credential');
  });

  test('pi with no credentials cannot start either', async () => {
    secretsEnv = {};
    repoFiles = SEEDED_TREE;
    const state = await resolveProjectComposerState({
      project: PROJECT,
      userId: 'user-1',
      metadata: {},
    });

    const pi = await state.capabilities('piAgent');
    expect(pi.can_start).toBe(false);
    expect(pi.auth.ready).toBe(false);
  });

  test('connecting a real credential unblocks it — the gate is auth, not the seed', async () => {
    secretsEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-oauth-test' };
    repoFiles = SEEDED_TREE;
    const state = await resolveProjectComposerState({
      project: PROJECT,
      userId: 'user-1',
      metadata: {},
    });

    const claude = await state.capabilities('claudeAgent');
    expect(claude.can_start).toBe(true);
    expect(claude.auth.active).toBe('claude_subscription');
    expect(claude.blocking_reason).toBeNull();
  });

  test('a project that really does commit .claude/settings.json keeps its native_config route', async () => {
    secretsEnv = {};
    repoFiles = [...SEEDED_TREE, file('.claude/settings.json')];
    const state = await resolveProjectComposerState({
      project: PROJECT,
      userId: 'user-1',
      metadata: {},
    });

    const claude = await state.capabilities('claudeAgent');
    expect(claude.can_start).toBe(true);
    expect(claude.auth.active).toBe('native_config');
  });
});
