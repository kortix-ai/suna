import { describe, expect, test } from 'bun:test';
import { buildSessionRuntimeEnv } from './session-runtime-env';

const BASE_INPUT = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  repoUrl: 'https://example.test/acme/repo.git',
  baseRef: 'main',
  agentName: 'default',
  apiUrl: 'https://api.kortix.test/v1',
};

describe('buildSessionRuntimeEnv — server-claimed initial turn', () => {
  test('never injects the prompt or turn-ledger identity', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);

    expect(env).not.toHaveProperty('KORTIX_INITIAL_PROMPT');
    expect(env).not.toHaveProperty('KORTIX_INITIAL_TURN_TOKEN');
    expect(env).not.toHaveProperty('KORTIX_INITIAL_TURN_MESSAGE_ID');
  });

});

describe('buildSessionRuntimeEnv — KORTIX_COMPILED_AGENT_CONFIG', () => {
  test('omits the key entirely for a v1 project (compiledAgentConfig absent) — byte-for-byte unaffected', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('omits the key when compiledAgentConfig is explicitly null', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: null });
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('carries the compiled JSON through verbatim for a v2 project', () => {
    const compiled = JSON.stringify({ agent: { support: { mode: 'primary' } } });
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledAgentConfig: compiled });
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
  });

  test('coexists with KORTIX_OPENCODE_MODEL — the per-session override key is unaffected', () => {
    const compiled = JSON.stringify({ agent: {} });
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledAgentConfig: compiled,
      opencodeModel: 'anthropic/claude-opus-4-8',
    });
    expect(env.KORTIX_OPENCODE_MODEL).toBe('anthropic/claude-opus-4-8');
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
  });

  test('ignores legacy attribution input and emits no attribution variables', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      originRef: 'legacy-reference',
    } as Parameters<typeof buildSessionRuntimeEnv>[0]);

    expect(env).not.toHaveProperty('KORTIX_END_USER_REF');
    expect(env).not.toHaveProperty('KORTIX_ORIGIN_REF');
  });
});

describe('buildSessionRuntimeEnv — workspace mode', () => {
  test('runtime mode removes every project Git coordinate', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      workspaceMode: 'runtime',
    });

    expect(env.KORTIX_WORKSPACE_MODE).toBe('runtime');
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('0');
    expect(env).not.toHaveProperty('KORTIX_REPO_URL');
    expect(env).not.toHaveProperty('KORTIX_DEFAULT_BRANCH');
    expect(env).not.toHaveProperty('KORTIX_BASE_REF');
    expect(env).not.toHaveProperty('KORTIX_BRANCH_NAME');
  });

  test('read mode cannot clone before exact-path artifacts are implemented', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      workspaceMode: 'read',
    });

    expect(env.KORTIX_WORKSPACE_MODE).toBe('read');
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('0');
    expect(env).not.toHaveProperty('KORTIX_REPO_URL');
    expect(env).not.toHaveProperty('KORTIX_DEFAULT_BRANCH');
    expect(env).not.toHaveProperty('KORTIX_BASE_REF');
    expect(env).not.toHaveProperty('KORTIX_BRANCH_NAME');
  });

  test('legacy and branch sessions keep the project clone and Git coordinates', () => {
    for (const env of [
      buildSessionRuntimeEnv(BASE_INPUT),
      buildSessionRuntimeEnv({ ...BASE_INPUT, workspaceMode: 'branch' }),
    ]) {
      expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('1');
      expect(env.KORTIX_REPO_URL).toBe(BASE_INPUT.repoUrl);
      expect(env.KORTIX_DEFAULT_BRANCH).toBe(BASE_INPUT.baseRef);
      expect(env.KORTIX_BASE_REF).toBe(BASE_INPUT.baseRef);
      expect(env.KORTIX_BRANCH_NAME).toBe(BASE_INPUT.sessionId);
    }
  });
});

describe('buildSessionRuntimeEnv — fast Git boot hints', () => {
  test('enables compiled checkout independently from the legacy fast-cold-boot flag', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledBootMode: 'prefer',
      fastColdBootEnabled: false,
      freshSession: true,
      baseSha: 'a'.repeat(40),
    });

    expect(env.KORTIX_COMPILED_BOOT_MODE).toBe('prefer');
    expect(env.KORTIX_SESSION_FRESH).toBe('1');
    expect(env.KORTIX_BASE_SHA).toBe('a'.repeat(40));
    expect(env).not.toHaveProperty('KORTIX_OPENCODE_BINARY_PREFETCH');
  });

  test('emits required mode for strict compiled runtime verification', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledBootMode: 'required',
      freshSession: true,
      baseSha: 'a'.repeat(40),
    });

    expect(env.KORTIX_COMPILED_BOOT_MODE).toBe('required');
    expect(env.KORTIX_BASE_SHA).toBe('a'.repeat(40));
  });

  test('keeps off, resumed, and repository-free sessions on the existing path', () => {
    for (const env of [
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        compiledBootMode: 'off',
        freshSession: true,
        baseSha: 'a'.repeat(40),
      }),
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        compiledBootMode: 'prefer',
        freshSession: false,
        baseSha: 'a'.repeat(40),
      }),
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        workspaceMode: 'runtime',
        compiledBootMode: 'prefer',
        freshSession: true,
        baseSha: 'a'.repeat(40),
      }),
    ]) {
      expect(env).not.toHaveProperty('KORTIX_COMPILED_BOOT_MODE');
    }
  });

  test('marks replacement runtimes for remote session-branch restoration', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      restoreSessionBranch: true,
    });

    expect(env.KORTIX_SESSION_BRANCH_RESTORE).toBe('1');
    expect(env).not.toHaveProperty('KORTIX_SESSION_FRESH');
  });

  test('does not emit branch-restore authority for repository-free workspaces', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      workspaceMode: 'runtime',
      restoreSessionBranch: true,
    });

    expect(env).not.toHaveProperty('KORTIX_SESSION_BRANCH_RESTORE');
  });

  test('sends fresh-session and base-tip hints when the experiment is enabled', () => {
    const baseSha = 'a'.repeat(40);
    const gitDeltaBundleBase64 = 'R0lUIEJVTkRMRQ==';
    const gitDeltaParentSha = 'b'.repeat(40);
    const gitDeltaParentCommitBase64 = 'dHJlZSBkZWFkYmVlZgo=';
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      fastColdBootEnabled: true,
      freshSession: true,
      baseSha,
      gitDeltaBundleBase64,
      gitDeltaParentSha,
      gitDeltaParentCommitBase64,
    });

    expect(env.KORTIX_SESSION_FRESH).toBe('1');
    expect(env.KORTIX_BASE_SHA).toBe(baseSha);
    expect(env.KORTIX_GIT_DELTA_BUNDLE_BASE64).toBe(gitDeltaBundleBase64);
    expect(env.KORTIX_GIT_DELTA_PARENT_SHA).toBe(gitDeltaParentSha);
    expect(env.KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64).toBe(gitDeltaParentCommitBase64);
  });

  test('omits both hints when the experiment is disabled', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      fastColdBootEnabled: false,
      freshSession: true,
      baseSha: 'a'.repeat(40),
      gitDeltaBundleBase64: 'R0lUIEJVTkRMRQ==',
      gitDeltaParentSha: 'b'.repeat(40),
      gitDeltaParentCommitBase64: 'dHJlZSBkZWFkYmVlZgo=',
    });

    expect(env).not.toHaveProperty('KORTIX_SESSION_FRESH');
    expect(env).not.toHaveProperty('KORTIX_BASE_SHA');
    expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_BUNDLE_BASE64');
    expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_PARENT_SHA');
    expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64');
  });

  test('omits both hints for resumed and non-repository sessions', () => {
    for (const env of [
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        fastColdBootEnabled: true,
        freshSession: false,
        baseSha: 'a'.repeat(40),
        gitDeltaBundleBase64: 'R0lUIEJVTkRMRQ==',
        gitDeltaParentSha: 'b'.repeat(40),
        gitDeltaParentCommitBase64: 'dHJlZSBkZWFkYmVlZgo=',
      }),
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        workspaceMode: 'runtime',
        fastColdBootEnabled: true,
        freshSession: true,
        baseSha: 'a'.repeat(40),
        gitDeltaBundleBase64: 'R0lUIEJVTkRMRQ==',
        gitDeltaParentSha: 'b'.repeat(40),
        gitDeltaParentCommitBase64: 'dHJlZSBkZWFkYmVlZgo=',
      }),
    ]) {
      expect(env).not.toHaveProperty('KORTIX_SESSION_FRESH');
      expect(env).not.toHaveProperty('KORTIX_BASE_SHA');
      expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_BUNDLE_BASE64');
      expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_PARENT_SHA');
      expect(env).not.toHaveProperty('KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64');
    }
  });
});

describe('buildSessionRuntimeEnv — OpenCode executable prefetch', () => {
  test('enables prefetch through the single fast cold boot flag', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      fastColdBootEnabled: true,
      freshSession: false,
    });

    expect(env.KORTIX_OPENCODE_BINARY_PREFETCH).toBe('1');
    expect(env).not.toHaveProperty('KORTIX_SESSION_FRESH');
  });

  test('omits prefetch when the fast cold boot flag is disabled', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      fastColdBootEnabled: false,
      freshSession: true,
    });

    expect(env).not.toHaveProperty('KORTIX_OPENCODE_BINARY_PREFETCH');
  });

  test('keeps prefetch enabled for runtime-only sessions', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      workspaceMode: 'runtime',
      fastColdBootEnabled: true,
      freshSession: true,
    });

    expect(env.KORTIX_OPENCODE_BINARY_PREFETCH).toBe('1');
    expect(env).not.toHaveProperty('KORTIX_REPO_URL');
  });
});
