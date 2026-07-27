import { describe, expect, test } from 'bun:test';
import { buildSessionRuntimeEnv, sessionAutoCloneFlag } from './session-runtime-env';

const BASE_INPUT = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  repoUrl: 'https://example.test/acme/repo.git',
  baseRef: 'main',
  agentName: 'default',
  apiUrl: 'https://api.kortix.test/v1',
  opencodeProcessTransport: 'acp' as const,
};

describe('buildSessionRuntimeEnv — KORTIX_COMPILED_AGENT_CONFIG', () => {
  test('passes the server-selected OpenCode process transport into the sandbox', () => {
    expect(
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        opencodeProcessTransport: 'acp',
      }).KORTIX_OPENCODE_PROCESS_TRANSPORT,
    ).toBe('acp');
    expect(
      buildSessionRuntimeEnv({
        ...BASE_INPUT,
        opencodeProcessTransport: 'rest',
      }).KORTIX_OPENCODE_PROCESS_TRANSPORT,
    ).toBe('rest');
  });

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
});

describe('sessionAutoCloneFlag — R-36, the AGI boots without a checkout', () => {
  test('the platform AGI boots with auto-clone OFF', () => {
    // Boot awaits materializeRepo only `if (cfg.autoClone)`, and health's
    // repoRequired is derived from the same flag — so '0' is what takes the
    // clone off the AGI's boot critical path.
    expect(sessionAutoCloneFlag('kortix-agi')).toBe('0');
  });

  test('every other agent still gets its checkout', () => {
    expect(sessionAutoCloneFlag('default')).toBe('1');
    expect(sessionAutoCloneFlag('kortix')).toBe('1');
  });

  test('a lookalike name is NOT the AGI', () => {
    // isAgiAgentName is exact equality (agents.ts). A prefix/substring match
    // here would silently boot an ordinary workspace agent with no repo — it
    // would find an empty working directory and have nothing to edit.
    expect(sessionAutoCloneFlag('kortix-agi-lookalike')).toBe('1');
    expect(sessionAutoCloneFlag('agi')).toBe('1');
    expect(sessionAutoCloneFlag('KORTIX-AGI')).toBe('1');
  });
});
