import { describe, expect, test } from 'bun:test';
import { buildSessionRuntimeEnv, runtimeModelForHarness } from './session-runtime-env';

const BASE_INPUT = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  repoUrl: 'https://example.test/acme/repo.git',
  baseRef: 'main',
  agentName: 'default',
  apiUrl: 'https://api.kortix.test/v1',
};

const CLAUDE_PLAN = {
  kind: 'acp',
  version: 3,
  defaultAgent: 'claude',
  runtimes: { claude: { name: 'claude', harness: 'claude', configDir: '.claude' } },
  agents: {
    claude: {
      name: 'claude', runtime: 'claude', harness: 'claude', nativeAgent: null, enabled: true,
      connectors: 'none', secrets: 'none', skills: 'none', kortixCli: 'none', workspace: 'runtime',
    },
  },
} as const;

describe('runtimeModelForHarness', () => {
  test('strips the kortix/ gateway namespace for non-opencode harnesses', () => {
    expect(runtimeModelForHarness('kortix/claude-opus-4.8', 'claude')).toBe('claude-opus-4.8');
    expect(runtimeModelForHarness('kortix/gpt-5.4', 'codex')).toBe('gpt-5.4');
    expect(runtimeModelForHarness('kortix/glm-5.2', 'pi')).toBe('glm-5.2');
  });

  test('keeps the provider-qualified id for opencode (its config declares the provider)', () => {
    expect(runtimeModelForHarness('kortix/claude-opus-4.8', 'opencode')).toBe('kortix/claude-opus-4.8');
  });

  test('non-kortix ids pass through untouched (real upstream ids may contain slashes)', () => {
    expect(runtimeModelForHarness('openai/gpt-5.4', 'codex')).toBe('openai/gpt-5.4');
    expect(runtimeModelForHarness('claude-sonnet-4-6', 'claude')).toBe('claude-sonnet-4-6');
    expect(runtimeModelForHarness('  ', 'claude')).toBeNull();
    expect(runtimeModelForHarness(null, 'claude')).toBeNull();
  });
});

describe('buildSessionRuntimeEnv — model + sentinel translation', () => {
  test('a kortix-namespaced pick reaches a claude harness as the bare model id', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      agentName: 'claude',
      compiledRuntimeConfig: CLAUDE_PLAN,
      runtimeModel: 'kortix/claude-opus-4.8',
    });
    expect(env.KORTIX_RUNTIME_MODEL).toBe('claude-opus-4.8');
  });

  test("the 'default' sentinel resolves to the compiled default agent instead of throwing", () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      agentName: 'default',
      compiledRuntimeConfig: CLAUDE_PLAN,
    });
    expect(env.KORTIX_RUNTIME_HARNESS).toBe('claude');
    expect(env.KORTIX_RUNTIME_NAME).toBe('claude');
  });
});

describe('buildSessionRuntimeEnv — KORTIX_COMPILED_AGENT_CONFIG', () => {
  test('omits the key entirely for a v1 project — byte-for-byte unaffected', () => {
    const env = buildSessionRuntimeEnv(BASE_INPUT);
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('omits the key when compiledRuntimeConfig is explicitly null', () => {
    const env = buildSessionRuntimeEnv({ ...BASE_INPUT, compiledRuntimeConfig: null });
    expect(env).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG');
  });

  test('v2 is launched through the OpenCode ACP adapter', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledRuntimeConfig: {
        kind: 'acp', version: 2, defaultAgent: 'default',
        runtimes: { opencode: { name: 'opencode', harness: 'opencode', configDir: '.kortix/opencode' } },
        agents: { default: { name: 'default', runtime: 'opencode', harness: 'opencode', nativeAgent: 'default', enabled: true, connectors: 'none', secrets: 'none', skills: 'none', kortixCli: 'none', workspace: 'runtime' } },
      },
    });
    expect(env.KORTIX_RUNTIME_HARNESS).toBe('opencode');
    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBeUndefined();
  });

  test('translates a model override into the harness-neutral ACP launch key', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      compiledRuntimeConfig: {
        kind: 'acp', version: 2, defaultAgent: 'default',
        runtimes: { opencode: { name: 'opencode', harness: 'opencode', configDir: '.kortix/opencode' } },
        agents: { default: { name: 'default', runtime: 'opencode', harness: 'opencode', nativeAgent: 'default', enabled: true, connectors: 'none', secrets: 'none', skills: 'none', kortixCli: 'none', workspace: 'runtime' } },
      },
      runtimeModel: 'anthropic/claude-opus-4-8',
    });
    expect(env.KORTIX_OPENCODE_MODEL).toBeUndefined();
    expect(env.KORTIX_RUNTIME_MODEL).toBe('anthropic/claude-opus-4-8');
  });

  test('v3 emits only the selected ACP runtime contract and no OpenCode bootstrap', () => {
    const env = buildSessionRuntimeEnv({
      ...BASE_INPUT,
      agentName: 'reviewer',
      runtimeModel: 'must/not-leak',
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
    expect(env.KORTIX_RUNTIME_MODEL).toBe('must/not-leak');
  });
});
