import { describe, expect, test } from 'bun:test';

import {
  buildSessionRuntimeEnv,
  shouldResolvePlatformDefaultModel,
} from '../projects/lib/session-runtime-env';
import type { CompiledRuntimeConfig } from '../projects/lib/compile-runtime-config';

const base = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  repoUrl: 'https://github.com/kortix/project.git',
  baseRef: 'main',
  agentName: 'default',
  apiUrl: 'https://api.kortix.test/v1',
  opencodeProcessTransport: 'acp' as const,
};

describe('buildSessionRuntimeEnv', () => {
  test('always asks the sandbox daemon to bootstrap the OpenCode root', () => {
    const env = buildSessionRuntimeEnv(base);

    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(env.KORTIX_INITIAL_PROMPT).toBeUndefined();
    expect(env.KORTIX_REPO_URL).toBe(base.repoUrl);
    expect(env.KORTIX_BRANCH_NAME).toBe(base.sessionId);
  });

  test('adds first-turn and model payload without changing root ownership', () => {
    const env = buildSessionRuntimeEnv({
      ...base,
      initialPrompt: 'answer this Slack thread',
      opencodeModel: 'anthropic/claude-sonnet-4-6',
    });

    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(env.KORTIX_INITIAL_PROMPT).toBe('answer this Slack thread');
    expect(env.KORTIX_OPENCODE_MODEL).toBe('anthropic/claude-sonnet-4-6');
  });

  test('emits a neutral immutable launch contract for a v3 Codex agent', () => {
    const plan: CompiledRuntimeConfig = {
      kind: 'acp',
      version: 3,
      defaultAgent: 'codex',
      runtimes: {
        codex: {
          name: 'codex',
          harness: 'codex',
          configDir: '.codex',
        },
      },
      agents: {
        codex: {
          name: 'codex',
          runtime: 'codex',
          harness: 'codex',
          nativeAgent: 'reviewer',
          enabled: true,
          connectors: 'none',
          secrets: 'none',
          skills: 'none',
          kortixCli: 'none',
          workspace: 'runtime',
        },
      },
    };
    const env = buildSessionRuntimeEnv({
      ...base,
      agentName: 'codex',
      compiledRuntimeConfig: plan,
      runtimeModel: 'kortix/openai/gpt-5.6-codex',
    });

    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBeUndefined();
    expect(env.KORTIX_ACP_SERVER_ID).toBe(base.sessionId);
    expect(env.KORTIX_RUNTIME_HARNESS).toBe('codex');
    expect(env.KORTIX_RUNTIME_NAME).toBe('codex');
    expect(env.KORTIX_RUNTIME_CONFIG_DIR).toBe('.codex');
    expect(env.KORTIX_NATIVE_AGENT).toBe('reviewer');
    expect(env.KORTIX_RUNTIME_MODEL).toBe('openai/gpt-5.6-codex');
    expect(env.KORTIX_COMPILED_RUNTIME_PLAN).toBeDefined();
    expect(JSON.parse(env.KORTIX_COMPILED_RUNTIME_PLAN ?? '{}')).toEqual(plan);
  });

  test('rejects an undeclared or disabled v3 session agent', () => {
    const plan: CompiledRuntimeConfig = {
      kind: 'acp',
      version: 3,
      defaultAgent: 'codex',
      runtimes: {
        codex: { name: 'codex', harness: 'codex', configDir: '.codex' },
      },
      agents: {
        codex: {
          name: 'codex',
          runtime: 'codex',
          harness: 'codex',
          nativeAgent: null,
          enabled: false,
          connectors: 'none',
          secrets: 'none',
          skills: 'none',
          kortixCli: 'none',
          workspace: 'runtime',
        },
      },
    };
    expect(() =>
      buildSessionRuntimeEnv({
        ...base,
        agentName: 'codex',
        compiledRuntimeConfig: plan,
      }),
    ).toThrow('not declared and enabled');
  });

  test('rejects a v3 session agent with a missing runtime profile', () => {
    const plan: CompiledRuntimeConfig = {
      kind: 'acp',
      version: 3,
      defaultAgent: 'codex',
      runtimes: {},
      agents: {
        codex: {
          name: 'codex',
          runtime: 'missing',
          harness: 'codex',
          nativeAgent: null,
          enabled: true,
          connectors: 'none',
          secrets: 'none',
          skills: 'none',
          kortixCli: 'none',
          workspace: 'runtime',
        },
      },
    };
    expect(() =>
      buildSessionRuntimeEnv({
        ...base,
        agentName: 'codex',
        compiledRuntimeConfig: plan,
      }),
    ).toThrow('references unknown runtime profile "missing"');
  });
});

describe('shouldResolvePlatformDefaultModel', () => {
  test('keeps Claude Code and Codex on their native defaults', () => {
    expect(shouldResolvePlatformDefaultModel(true, 'claude')).toBe(false);
    expect(shouldResolvePlatformDefaultModel(true, 'codex')).toBe(false);
  });

  test('keeps platform defaults for REST, OpenCode ACP, and Pi ACP', () => {
    expect(shouldResolvePlatformDefaultModel(false, 'codex')).toBe(true);
    expect(shouldResolvePlatformDefaultModel(true, 'opencode')).toBe(true);
    expect(shouldResolvePlatformDefaultModel(true, 'pi')).toBe(true);
  });
});
