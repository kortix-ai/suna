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
    expect(secretGrantEnvForRunningAgent(l, 'kortix')).toEqual(['STRIPE']);
  });

  test('a switch between agents with equal grants resolves the running agent', () => {
    const l = loaded([spec('a', ['STRIPE']), spec('b', ['stripe'])]);
    expect(secretGrantEnvForRunningAgent(l, 'b')).toEqual(['stripe']);
  });

  // The four tests below used to assert a throw. A grant change is no longer a
  // refusal — the env is re-scoped onto whichever agent runs. Each one now pins
  // the RESOLVED grant, which is the property that actually protects secrets.
  test('a switch that widens the grant resolves to the wider running grant', () => {
    const l = loaded([spec('narrow', ['STRIPE']), spec('broad', 'all')]);
    expect(secretGrantEnvForRunningAgent(l, 'broad')).toBe('all');
  });

  test('a switch that narrows the grant resolves to the narrower running grant', () => {
    const l = loaded([spec('narrow', ['STRIPE']), spec('broad', 'all')]);
    expect(secretGrantEnvForRunningAgent(l, 'narrow')).toEqual(['STRIPE']);
  });

  test('an undeclared agent gets the default-deny grant, not the session agent grant', () => {
    const l = loaded([spec('kortix', 'all')]);
    // The point: 'ghost' must NOT inherit kortix's `all`. Default-deny is an
    // empty list, so a switch to an undeclared agent reads nothing.
    expect(secretGrantEnvForRunningAgent(l, 'ghost')).toEqual([]);
  });

  test('an ungoverned session switching to an all-granted agent resolves to all', () => {
    const l = loaded([spec('kortix', 'all')], 'kortix');
    expect(secretGrantEnvForRunningAgent(l, 'kortix')).toBe('all');
  });

  test('the resolved grant never depends on the session agent — only on the running one', () => {
    const l = loaded([spec('narrow', ['STRIPE']), spec('broad', 'all')]);
    // Same running agent, and there is no second argument that could change the
    // answer. This is the invariant the removed lock kept breaking.
    expect(secretGrantEnvForRunningAgent(l, 'narrow')).toEqual(['STRIPE']);
    expect(secretGrantEnvForRunningAgent(l, 'broad')).toBe('all');
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

  test('re-scopes a requested agent whose grant differs, in BOTH directions', async () => {
    loadProjectAgentsImpl = async () =>
      loaded([spec('narrow', ['NPM_TOKEN']), spec('broad', 'all')]);
    // Widening: this exact call used to reject with a 409 all the way out to the
    // user, including when the operator flag was off (the network-boundary leg
    // hit the resolver's `?? true` default). It must resolve.
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'narrow', requestedAgent: 'broad' }),
    ).resolves.toBe('all');
    // Narrowing: the running agent's smaller grant wins. The session agent's
    // wider grant must not leak into the switched-to agent's env.
    await expect(
      resolveSessionSecretGrant({ ...PROJECT, sessionAgent: 'broad', requestedAgent: 'narrow' }),
    ).resolves.toEqual(['NPM_TOKEN']);
  });

  test('re-scopes the FULL grant onto the running agent', async () => {
    loadProjectAgentsImpl = async () =>
      loaded([
        spec('narrow', ['NPM_TOKEN'], { connectors: ['registry'], kortixCli: [] }),
        spec('broad', 'all', { connectors: 'all', kortixCli: 'all' }),
      ]);

    const grant = await resolveSessionAgentGrant({
      ...PROJECT,
      sessionAgent: 'narrow',
      requestedAgent: 'broad',
    });

    expect(grant).toMatchObject({
      agent: 'broad',
      env: 'all',
      connectors: 'all',
      kortixCli: 'all',
    });
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
