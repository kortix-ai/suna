import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyAcpSessionDefaults,
  createAcpHarnessRegistry,
  isolateHarnessAuthEnv,
  resolveAcpHarnessLaunchEnv,
} from '../acp/harness-registry';

describe('ACP harness registry', () => {
  test('passes the manifest-selected Claude agent through sanctioned ACP session metadata', () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 7,
      method: 'session/new',
      params: {
        cwd: '/workspace',
        mcpServers: [],
        _meta: {
          trace: 'keep-me',
          claudeCode: { options: { permissionMode: 'default' } },
        },
      },
    };

    expect(applyAcpSessionDefaults('claude', request, {
      KORTIX_NATIVE_AGENT: 'reviewer',
    })).toEqual({
      ...request,
      params: {
        ...request.params,
        _meta: {
          trace: 'keep-me',
          claudeCode: {
            options: { permissionMode: 'default', agent: 'reviewer' },
          },
        },
      },
    });
    expect(request.params._meta.claudeCode.options).toEqual({ permissionMode: 'default' });
  });

  test('does not invent native-agent ACP fields for harnesses without one', () => {
    const request = {
      jsonrpc: '2.0' as const,
      id: 8,
      method: 'session/new',
      params: { cwd: '/workspace', mcpServers: [] },
    };
    for (const harness of ['codex', 'opencode', 'pi'] as const) {
      expect(applyAcpSessionDefaults(harness, request, {
        KORTIX_NATIVE_AGENT: 'reviewer',
      })).toBe(request);
    }
  });

  test('an explicit auth route removes every competing provider credential', () => {
    expect(isolateHarnessAuthEnv({
      KORTIX_RUNTIME_AUTH_KIND: 'claude_subscription',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_KEY: 'openai-key',
      CUSTOM_LLM_PROTOCOL: 'anthropic',
      CUSTOM_LLM_BASE_URL: 'https://custom.example.test',
    })).toMatchObject({
      KORTIX_RUNTIME_AUTH_KIND: 'claude_subscription',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription',
    });
    const isolated = isolateHarnessAuthEnv({
      KORTIX_RUNTIME_AUTH_KIND: 'claude_subscription',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_KEY: 'openai-key',
      CUSTOM_LLM_PROTOCOL: 'anthropic',
      CUSTOM_LLM_BASE_URL: 'https://custom.example.test',
    });
    expect(isolated.ANTHROPIC_API_KEY).toBeUndefined();
    expect(isolated.OPENAI_API_KEY).toBeUndefined();
    expect(isolated.CUSTOM_LLM_BASE_URL).toBeUndefined();
  });

  test('native config never silently falls back to the Kortix gateway', () => {
    const env = {
      KORTIX_RUNTIME_AUTH_KIND: 'native_config',
      KORTIX_API_URL: 'https://api.example.test/v1',
      KORTIX_TOKEN: 'sandbox-token',
      KORTIX_RUNTIME_CONFIG_DIR: '.codex',
    };
    expect(resolveAcpHarnessLaunchEnv('codex', env)).toEqual({ CODEX_HOME: '/workspace/.codex' });
    expect(resolveAcpHarnessLaunchEnv('claude', env)).toEqual({ CLAUDE_CONFIG_DIR: '/workspace/.codex' });
    expect(resolveAcpHarnessLaunchEnv('pi', env)).toEqual({ PI_CODING_AGENT_DIR: '/workspace/.codex' });
  });

  test('native config does not inherit unrelated provider credentials', () => {
    const isolated = isolateHarnessAuthEnv({
      KORTIX_RUNTIME_AUTH_KIND: 'native_config',
      KORTIX_RUNTIME_CONFIG_DIR: '.claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
      ANTHROPIC_API_KEY: 'anthropic-key',
      CODEX_AUTH_JSON: '{"tokens":true}',
      OPENAI_API_KEY: 'openai-key',
      CUSTOM_LLM_PROTOCOL: 'anthropic',
      CUSTOM_LLM_BASE_URL: 'https://custom.example.test',
    });
    expect(isolated.KORTIX_RUNTIME_CONFIG_DIR).toBe('.claude');
    for (const name of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'CODEX_AUTH_JSON',
      'OPENAI_API_KEY',
      'CUSTOM_LLM_PROTOCOL',
      'CUSTOM_LLM_BASE_URL',
    ]) {
      expect(isolated[name]).toBeUndefined();
    }
  });
  test('uses image-stable absolute paths for installed ACP adapters', () => {
    const registry = createAcpHarnessRegistry({});
    expect(registry.get('claude')?.launch).toMatchObject({
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'],
    });
    expect(registry.get('codex')?.launch).toMatchObject({
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js'],
    });
    expect(registry.get('pi')?.launch).toMatchObject({
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/pi-acp/dist/index.js'],
    });
  });

  test('routes Claude through the scoped Kortix Anthropic gateway by default', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.example.test/v1/',
      KORTIX_TOKEN: 'sandbox-token',
    });
    expect(registry.get('claude')?.launch.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example.test/v1/router',
      ANTHROPIC_AUTH_TOKEN: 'sandbox-token',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    });
  });

  test('preserves native Claude credentials when the project supplied them', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.example.test/v1',
      KORTIX_TOKEN: 'sandbox-token',
      ANTHROPIC_API_KEY: 'project-key',
    });
    expect(registry.get('claude')?.launch.env).toBeUndefined();
  });

  test('applies the session model to native Claude credentials', () => {
    expect(
      resolveAcpHarnessLaunchEnv('claude', {
        ANTHROPIC_API_KEY: 'project-key',
        KORTIX_RUNTIME_MODEL: 'claude-custom',
      }),
    ).toEqual({ ANTHROPIC_MODEL: 'claude-custom' });
  });

  for (const credential of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const) {
    test(`uses ${credential} natively for Claude`, () => {
      expect(
        resolveAcpHarnessLaunchEnv('claude', {
          KORTIX_API_URL: 'https://api.example.test/v1',
          KORTIX_TOKEN: 'sandbox-token',
          [credential]: 'project-credential',
        }),
      ).toBeUndefined();
    });
  }

  test('preserves Claude subscription auth instead of overriding it with gateway auth', () => {
    const registry = createAcpHarnessRegistry({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      KORTIX_API_URL: 'https://api.example.test/v1',
      KORTIX_TOKEN: 'sandbox-token',
    });
    expect(registry.get('claude')?.launch.env).toBeUndefined();
  });

  test('resolves credentials from the latest synchronized project environment', () => {
    const startup = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.example.test/v1',
      KORTIX_TOKEN: 'sandbox-token',
    });
    expect(startup.get('claude')?.launch.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'sandbox-token',
    });
    expect(
      resolveAcpHarnessLaunchEnv('claude', {
        KORTIX_API_URL: 'https://api.example.test/v1',
        KORTIX_TOKEN: 'sandbox-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      }),
    ).toBeUndefined();
  });

  test('routes Codex subscription auth through the refresh-capable Kortix gateway', () => {
    const registry = createAcpHarnessRegistry({
      CODEX_AUTH_JSON: '{"openai":{"type":"oauth"}}',
      KORTIX_API_URL: 'https://api.example.test/v1',
      KORTIX_TOKEN: 'sandbox-token',
    });
    expect(registry.get('codex')?.launch.env).toMatchObject({
      NO_BROWSER: '1',
      DEFAULT_AUTH_REQUEST: expect.stringContaining('Kortix Gateway'),
    });
  });

  test('routes Codex through the scoped Kortix Responses gateway by default', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.test/v1',
      KORTIX_TOKEN: 'token',
    });
    expect(registry.get('codex')?.launch.env).toEqual({
      NO_BROWSER: '1',
      CODEX_CONFIG: JSON.stringify({ model: 'openai/gpt-5.4' }),
      DEFAULT_AUTH_REQUEST: JSON.stringify({
        methodId: 'gateway',
        _meta: {
          gateway: {
            baseUrl: 'https://api.test/v1/router/openai',
            providerName: 'Kortix Gateway',
            headers: { Authorization: 'Bearer token' },
          },
        },
      }),
    });
    expect(registry.get('opencode')?.launch.env).toBeUndefined();
    expect(registry.get('pi')?.launch.env).toMatchObject({
      PI_TELEMETRY: '0',
      KORTIX_PI_MODELS_JSON: expect.stringContaining('gpt-5.4'),
    });
  });

  test('preserves native Codex credentials when the project supplied them', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_API_URL: 'https://api.test/v1',
      KORTIX_TOKEN: 'token',
      OPENAI_API_KEY: 'project-key',
    });
    expect(registry.get('codex')?.launch.env).toBeUndefined();
  });

  test('applies one harness-neutral session model to Codex, OpenCode, and Pi', () => {
    const env = {
      KORTIX_RUNTIME_MODEL: 'custom/session-model',
      KORTIX_API_URL: 'https://api.test/v1',
      KORTIX_TOKEN: 'token',
    };
    expect(resolveAcpHarnessLaunchEnv('codex', env)?.CODEX_CONFIG).toBe(
      JSON.stringify({ model: 'custom/session-model' }),
    );
    expect(resolveAcpHarnessLaunchEnv('opencode', env)?.OPENCODE_CONFIG_CONTENT).toContain(
      'custom/session-model',
    );
    expect(resolveAcpHarnessLaunchEnv('pi', env)?.KORTIX_PI_MODELS_JSON).toContain(
      'custom/session-model',
    );
  });

  for (const credential of ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const) {
    test(`uses ${credential} natively for Codex`, () => {
      expect(
        resolveAcpHarnessLaunchEnv('codex', {
          KORTIX_API_URL: 'https://api.test/v1',
          KORTIX_TOKEN: 'token',
          [credential]: 'project-credential',
        }),
      ).toBeUndefined();
    });
  }

  test('routes a logical Kortix agent to OpenCode through its native default agent', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_NATIVE_AGENT: 'reviewer',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'allow' }),
    });
    expect(
      JSON.parse(registry.get('opencode')?.launch.env?.OPENCODE_CONFIG_CONTENT ?? '{}'),
    ).toEqual({
      permission: 'allow',
      default_agent: 'reviewer',
    });
  });

  test('does not interpret an OpenCode native agent as a Codex profile', () => {
    const home = mkdtempSync(join(tmpdir(), 'kortix-opencode-profile-'));
    try {
      const registry = createAcpHarnessRegistry({
        KORTIX_RUNTIME_HARNESS: 'opencode',
        KORTIX_RUNTIME_CONFIG_DIR: home,
        KORTIX_NATIVE_AGENT: 'kortix',
      });
      expect(
        JSON.parse(registry.get('opencode')?.launch.env?.OPENCODE_CONFIG_CONTENT ?? '{}'),
      ).toMatchObject({ default_agent: 'kortix' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('layers a Codex native profile into the adapter config', () => {
    const home = mkdtempSync(join(tmpdir(), 'kortix-codex-profile-'));
    try {
      writeFileSync(join(home, 'reviewer.config.toml'), [
        'model = "gpt-5.4"',
        'developer_instructions = "Review only."',
      ].join('\n'));
      expect(resolveAcpHarnessLaunchEnv('codex', {
        KORTIX_RUNTIME_AUTH_KIND: 'native_config',
        KORTIX_RUNTIME_CONFIG_DIR: home,
        KORTIX_NATIVE_AGENT: 'reviewer',
      })).toEqual({
        CODEX_HOME: home,
        CODEX_CONFIG: JSON.stringify({
          model: 'gpt-5.4',
          developer_instructions: 'Review only.',
        }),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('translates one OpenAI-compatible REST connection for Codex, OpenCode, and Pi', () => {
    const env = {
      CUSTOM_LLM_PROTOCOL: 'openai',
      CUSTOM_LLM_BASE_URL: 'https://llm.example.test/v1/',
      CUSTOM_LLM_API_KEY: 'custom-key',
      CUSTOM_LLM_MODEL_ID: 'custom/model',
    };
    expect(resolveAcpHarnessLaunchEnv('codex', env)).toMatchObject({
      CODEX_CONFIG: JSON.stringify({ model: 'custom/model' }),
      DEFAULT_AUTH_REQUEST: expect.stringContaining('https://llm.example.test/v1'),
    });
    expect(resolveAcpHarnessLaunchEnv('opencode', env)?.OPENCODE_CONFIG_CONTENT).toContain(
      '@ai-sdk/openai-compatible',
    );
    expect(resolveAcpHarnessLaunchEnv('pi', env)?.KORTIX_PI_MODELS_JSON).toContain('custom/model');
    expect(resolveAcpHarnessLaunchEnv('claude', env)).toBeUndefined();
  });

  test('translates an Anthropic-compatible REST connection only for Claude', () => {
    const env = {
      CUSTOM_LLM_PROTOCOL: 'anthropic',
      CUSTOM_LLM_BASE_URL: 'https://anthropic.example.test/',
      CUSTOM_LLM_API_KEY: 'custom-key',
      CUSTOM_LLM_MODEL_ID: 'custom-claude',
    };
    expect(resolveAcpHarnessLaunchEnv('claude', env)).toEqual({
      ANTHROPIC_BASE_URL: 'https://anthropic.example.test',
      ANTHROPIC_AUTH_TOKEN: 'custom-key',
      ANTHROPIC_MODEL: 'custom-claude',
    });
    expect(resolveAcpHarnessLaunchEnv('codex', env)).toBeUndefined();
  });

  test('maps the compiled runtime config directory to each harness native environment', () => {
    const registry = createAcpHarnessRegistry({
      KORTIX_RUNTIME_CONFIG_DIR: '.config/agent',
      KORTIX_WORKSPACE: '/workspace',
    });
    expect(registry.get('claude')?.launch.env).toEqual({
      CLAUDE_CONFIG_DIR: '/workspace/.config/agent',
    });
    expect(registry.get('codex')?.launch.env).toEqual({
      CODEX_HOME: '/workspace/.config/agent',
    });
    expect(registry.get('opencode')?.launch.env).toEqual({
      OPENCODE_CONFIG_DIR: '/workspace/.config/agent',
    });
    expect(registry.get('pi')?.launch.env).toEqual({
      PI_CODING_AGENT_DIR: '/workspace/.config/agent',
    });
  });
});
