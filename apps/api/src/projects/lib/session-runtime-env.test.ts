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
  test('omits the key entirely for a v1 project — byte-for-byte unaffected', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('omits the key when compiledRuntimeConfig is explicitly null', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledRuntimeConfig: null });
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('carries the compiled JSON through verbatim for a v2 project', () => {
    const config = { agent: { support: { mode: 'primary' as const } } };
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledRuntimeConfig: { kind: 'opencode-legacy', version: 2, config },
    });
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(JSON.stringify(config));
  });

  test('coexists with KORTIX_OPENCODE_MODEL — the per-session override key is unaffected', () => {
    const config = { agent: {} };
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledRuntimeConfig: { kind: 'opencode-legacy', version: 2, config },
      opencodeModel: 'anthropic/claude-opus-4-8',
    });
    expect(env.KORTIX_OPENCODE_MODEL).toBe('anthropic/claude-opus-4-8');
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(JSON.stringify(config));
  });

  test('v3 emits only the selected ACP runtime contract and no OpenCode bootstrap', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      agentName: 'reviewer',
      opencodeModel: 'must/not-leak',
      compiledRuntimeConfig: {
        kind: 'acp',
        version: 3,
        defaultAgent: 'reviewer',
        runtimes: {
          codex: { name: 'codex', harness: 'codex', configDir: '.codex' },
        },
        agents: {
          reviewer: {
            name: 'reviewer',
            runtime: 'codex',
            harness: 'codex',
            nativeAgent: 'strict',
            enabled: true,
            connectors: 'none',
            secrets: 'none',
            skills: 'none',
            kortixCli: 'none',
            workspace: 'runtime',
          },
        },
      },
    });

    expect(JSON.parse(env.KORTIX_COMPILED_RUNTIME_PLAN).kind).toBe('acp');
    expect(env.KORTIX_RUNTIME_NAME).toBe('codex');
    expect(env.KORTIX_RUNTIME_HARNESS).toBe('codex');
    expect(env.KORTIX_RUNTIME_CONFIG_DIR).toBe('.codex');
    expect(env.KORTIX_NATIVE_AGENT).toBe('strict');
    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBeUndefined();
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBeUndefined();
    expect(env.KORTIX_OPENCODE_MODEL).toBeUndefined();
  });
});
