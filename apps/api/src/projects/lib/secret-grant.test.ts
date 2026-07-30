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
  agentGrantDiffers,
  SecretGrantResolutionError,
  effectiveRunningAgent,
  resolveSessionAgentGrant,
  resolveSessionSecretGrant,
  secretGrantEnvDiffers,
  secretGrantEnvForRunningAgent,
} = await import('./secret-grant');

function spec(
  name: string,
  env: AgentSpec['env'],
  extra: Partial<Pick<AgentSpec, 'connectors' | 'kortixCli'>> = {},
): AgentSpec {
  return {
    name,
    path: `kortix.yaml#agents.${name}`,
    enabled: true,
    connectors: [],
    kortixCli: [],
    env,
    file: null,
    model: null,
    ...extra,
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

describe('agentGrantDiffers', () => {
  const grant = (extra: Record<string, unknown>) =>
    ({ agent: 'a', kortixCli: 'all', connectors: 'all', env: 'all', ...extra }) as never;

  test('an identical grant is a free switch', () => {
    expect(agentGrantDiffers(grant({}), grant({}))).toBe(false);
  });

  test('a DIFFERENT connector grant is a switch, even when secrets match', () => {
    // The leg the secrets-only lock left open: the token's connector grant is
    // written once at mint, so the switched-to agent would call the boot
    // agent's connectors.
    expect(agentGrantDiffers(grant({}), grant({ connectors: ['calendar'] }))).toBe(true);
  });

  test('a DIFFERENT kortixCli grant is a switch too', () => {
    expect(agentGrantDiffers(grant({}), grant({ kortixCli: ['session.read'] }))).toBe(true);
  });

  test('order and duplicates in a connector list are not a difference', () => {
    expect(
      agentGrantDiffers(
        grant({ connectors: ['b', 'a', 'a'] }),
        grant({ connectors: ['a', 'b'] }),
      ),
    ).toBe(false);
  });

  test('connector case IS a difference — the call gate matches exactly', () => {
    // agentMayUseConnector uses includes(), not a case-insensitive compare, so
    // calling these equal here would predict the wrong thing at the gate.
    expect(agentGrantDiffers(grant({ connectors: ['Calendar'] }), grant({ connectors: ['calendar'] }))).toBe(
      true,
    );
  });

  test('a null grant is unrestricted, and equal to an explicit all', () => {
    expect(agentGrantDiffers(null, grant({}))).toBe(false);
  });

  test('an explicit EMPTY list is a real narrowing, not "all"', () => {
    expect(agentGrantDiffers(null, grant({ connectors: [] }))).toBe(true);
  });
});

describe('secretGrantEnvDiffers', () => {
  test('order and case do not make two identical grants differ', () => {
    expect(secretGrantEnvDiffers(['a', 'B'], ['b', 'A'])).toBe(false);
  });

  test('duplicates do not make two identical grants differ', () => {
    expect(secretGrantEnvDiffers(['A', 'A', 'B'], ['B', 'A'])).toBe(false);
  });

  test('unrestricted and all are the same authority, since every consumer treats them alike', () => {
    expect(secretGrantEnvDiffers(undefined, 'all')).toBe(false);
    expect(secretGrantEnvDiffers('all', undefined)).toBe(false);
  });

  test('an explicit list is a declared narrowing, distinct from both', () => {
    expect(secretGrantEnvDiffers(undefined, [])).toBe(true);
    expect(secretGrantEnvDiffers('all', [])).toBe(true);
    expect(secretGrantEnvDiffers('all', ['STRIPE'])).toBe(true);
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

  test('an ungoverned session switching to an all-granted agent is not a privilege change', () => {
    const l = loaded([spec('kortix', 'all')], 'kortix');
    expect(secretGrantEnvForRunningAgent(l, 'default', 'kortix')).toBe('all');
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

  test('ALLOWS a switch that changes only the connector grant', async () => {
    // Identical secrets, different connectors. This must NOT 409: per-agent
    // `connectors:` with no `secrets:` declared is the most ordinary manifest
    // shape there is, and the dashboard offers the switch. The connector
    // difference is handled by re-minting the token
    // (lib/session-token-grant.ts), which is possible precisely because those
    // grants are checked at call time rather than already sitting in the box.
    loadProjectAgentsImpl = async () =>
      loaded([
        spec('a', ['NPM_TOKEN'], { connectors: 'all' }),
        spec('b', ['NPM_TOKEN'], { connectors: ['calendar'] }),
      ]);
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'a', requestedAgent: 'b' }),
    ).resolves.toEqual(['NPM_TOKEN']);
  });

  test('resolveSessionAgentGrant returns the RUNNING agent grant, not the session one', async () => {
    loadProjectAgentsImpl = async () =>
      loaded([
        spec('a', ['NPM_TOKEN'], { connectors: 'all' }),
        spec('b', ['NPM_TOKEN'], { connectors: ['calendar'] }),
      ]);
    const grant = await resolveSessionAgentGrant({
      ...PROJECT,
      sessionAgent: 'a',
      requestedAgent: 'b',
    });
    expect(grant?.agent).toBe('b');
    expect(grant?.connectors).toEqual(['calendar']);
  });

  test('allows a switch between agents whose grants match in every dimension', async () => {
    loadProjectAgentsImpl = async () =>
      loaded([
        spec('a', ['NPM_TOKEN'], { connectors: ['calendar'], kortixCli: ['session.read'] }),
        spec('b', ['npm_token'], { connectors: ['calendar'], kortixCli: ['session.read'] }),
      ]);
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'a', requestedAgent: 'b' }),
    ).resolves.toEqual(['npm_token']);
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
