import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { AgentSpec, LoadedAgents } from '../agents';

const actualAgents = await import('../agents');

let loadProjectAgentsImpl: () => Promise<LoadedAgents> = async () => ({
  specs: [],
  errors: [],
  defaultAgent: null,
});

mock.module('../agents', () => ({
  ...actualAgents,
  loadProjectAgents: () => loadProjectAgentsImpl(),
}));

const {
  AgentSecretGrantMismatchError,
  SecretGrantResolutionError,
  effectiveRunningAgent,
  resolveSessionSecretGrant,
  secretGrantEnvDiffers,
  secretGrantEnvForRunningAgent,
} = await import('./secret-grant');

function spec(name: string, env: AgentSpec['env']): AgentSpec {
  return {
    name,
    path: `kortix.yaml#agents.${name}`,
    enabled: true,
    connectors: [],
    kortixCli: [],
    env,
    file: null,
    model: null,
  } as AgentSpec;
}

function loaded(specs: AgentSpec[], defaultAgent: string | null = null): LoadedAgents {
  return { specs, errors: [], defaultAgent };
}

const PROJECT = {
  projectId: 'p1',
  repoUrl: 'https://github.com/acme/repo',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

beforeEach(() => {
  loadProjectAgentsImpl = async () => ({ specs: [], errors: [], defaultAgent: null });
});

describe('effectiveRunningAgent', () => {
  test('a concrete requested agent is the one that runs', () => {
    expect(effectiveRunningAgent('release-bot', 'kortix')).toBe('release-bot');
  });

  test('the default sentinel resolves to the session agent, not a fresh lookup', () => {
    expect(effectiveRunningAgent('default', 'release-bot')).toBe('release-bot');
  });

  test('an absent or blank requested agent falls back to the session agent', () => {
    expect(effectiveRunningAgent(null, 'kortix')).toBe('kortix');
    expect(effectiveRunningAgent(undefined, 'kortix')).toBe('kortix');
    expect(effectiveRunningAgent('   ', 'kortix')).toBe('kortix');
  });

  test('surrounding whitespace does not create a distinct agent', () => {
    expect(effectiveRunningAgent('  release-bot  ', 'kortix')).toBe('release-bot');
  });
});

describe('secretGrantEnvDiffers', () => {
  test('order and case do not make two identical grants differ', () => {
    expect(secretGrantEnvDiffers(['a', 'B'], ['b', 'A'])).toBe(false);
  });

  test('duplicates do not make two identical grants differ', () => {
    expect(secretGrantEnvDiffers(['A', 'A', 'B'], ['B', 'A'])).toBe(false);
  });

  test('unrestricted, all, and empty are three distinct authorities', () => {
    expect(secretGrantEnvDiffers(undefined, 'all')).toBe(true);
    expect(secretGrantEnvDiffers(undefined, [])).toBe(true);
    expect(secretGrantEnvDiffers('all', [])).toBe(true);
  });

  test('the same authority does not differ from itself', () => {
    expect(secretGrantEnvDiffers(undefined, undefined)).toBe(false);
    expect(secretGrantEnvDiffers('all', 'all')).toBe(false);
    expect(secretGrantEnvDiffers([], [])).toBe(false);
  });

  test('a narrower list differs from a wider one', () => {
    expect(secretGrantEnvDiffers(['A', 'B'], ['A'])).toBe(true);
  });
});

describe('secretGrantEnvForRunningAgent', () => {
  test('no switch returns the running agent grant unchanged', () => {
    const l = loaded([spec('kortix', ['STRIPE'])]);
    expect(secretGrantEnvForRunningAgent(l, 'kortix', 'kortix')).toEqual(['STRIPE']);
  });

  test('a switch between agents with equal grants is allowed', () => {
    const l = loaded([spec('a', ['STRIPE']), spec('b', ['stripe'])]);
    expect(secretGrantEnvForRunningAgent(l, 'a', 'b')).toEqual(['stripe']);
  });

  test('a switch that would widen the grant is refused', () => {
    const l = loaded([spec('narrow', ['STRIPE']), spec('broad', 'all')]);
    expect(() => secretGrantEnvForRunningAgent(l, 'narrow', 'broad')).toThrow(
      AgentSecretGrantMismatchError,
    );
  });

  test('a switch that would narrow the grant is also refused', () => {
    const l = loaded([spec('narrow', ['STRIPE']), spec('broad', 'all')]);
    expect(() => secretGrantEnvForRunningAgent(l, 'broad', 'narrow')).toThrow(
      AgentSecretGrantMismatchError,
    );
  });

  test('an undeclared agent gets the default-deny grant and is refused against a granted session', () => {
    const l = loaded([spec('kortix', 'all')]);
    expect(() => secretGrantEnvForRunningAgent(l, 'kortix', 'ghost')).toThrow(
      AgentSecretGrantMismatchError,
    );
  });

  test('the kill switch degrades to the running agent grant instead of the session one', () => {
    const l = loaded([spec('narrow', ['STRIPE']), spec('broad', 'all')]);
    expect(secretGrantEnvForRunningAgent(l, 'broad', 'narrow', false)).toEqual(['STRIPE']);
  });

  test('the kill switch never restores the session agent grant on a switch', () => {
    const l = loaded([spec('narrow', ['STRIPE']), spec('broad', 'all')]);
    expect(secretGrantEnvForRunningAgent(l, 'narrow', 'broad', false)).toBe('all');
  });
});

describe('resolveSessionSecretGrant', () => {
  test('fails closed when the manifest loader throws', async () => {
    loadProjectAgentsImpl = async () => {
      throw new Error('git unreachable');
    };
    await expect(resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'kortix' })).rejects.toThrow(
      SecretGrantResolutionError,
    );
  });

  test('does not fall back to an unrestricted grant when the loader throws', async () => {
    loadProjectAgentsImpl = async () => {
      throw new Error('git unreachable');
    };
    const result = await resolveSessionSecretGrant({
      ...PROJECT,
      sessionAgent: 'kortix',
    }).catch((err) => err);
    expect(result).toBeInstanceOf(SecretGrantResolutionError);
  });

  test('a project without git context is unrestricted', async () => {
    loadProjectAgentsImpl = async () => {
      throw new Error('should not be called');
    };
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, defaultBranch: null, sessionAgent: 'kortix' }),
    ).resolves.toBeUndefined();
  });

  test('a project that has not adopted agents is unrestricted', async () => {
    loadProjectAgentsImpl = async () => loaded([]);
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'kortix' }),
    ).resolves.toBeUndefined();
  });

  test('resolves the declared grant for the session agent', async () => {
    loadProjectAgentsImpl = async () => loaded([spec('release-bot', ['NPM_TOKEN'])]);
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'release-bot' }),
    ).resolves.toEqual(['NPM_TOKEN']);
  });

  test('resolves from the requested agent, not the session column', async () => {
    loadProjectAgentsImpl = async () =>
      loaded([spec('a', ['NPM_TOKEN']), spec('b', ['npm_token'])]);
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'a', requestedAgent: 'b' }),
    ).resolves.toEqual(['npm_token']);
  });

  test('refuses a requested agent whose grant differs from the session agent', async () => {
    loadProjectAgentsImpl = async () =>
      loaded([spec('narrow', ['NPM_TOKEN']), spec('broad', 'all')]);
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'narrow', requestedAgent: 'broad' }),
    ).rejects.toThrow(AgentSecretGrantMismatchError);
  });

  test('the default sentinel on a bound session is not treated as a switch', async () => {
    loadProjectAgentsImpl = async () =>
      loaded([spec('narrow', ['NPM_TOKEN']), spec('broad', 'all')]);
    await expect(
      resolveSessionSecretGrant({
        ...PROJECT,
        sessionAgent: 'narrow',
        requestedAgent: 'default',
      }),
    ).resolves.toEqual(['NPM_TOKEN']);
  });
});
