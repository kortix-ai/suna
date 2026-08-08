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

describe('buildSessionRuntimeEnv — Workspace identity', () => {
  test('emits the canonical identifier and the Project compatibility alias', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);

    expect(env.KORTIX_WORKSPACE_ID).toBe(BASE_INPUT.projectId);
    expect(env.KORTIX_PROJECT_ID).toBe(BASE_INPUT.projectId);
  });
});
