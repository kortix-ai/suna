/**
 * The reserved platform-AGI name — docs/specs/2026-07-26-agi-autonomous-operations.md
 * §9 (R-34/R-35/R-39).
 *
 * A trigger targets an agent BY NAME, and every name used to be resolved through
 * the manifest roster: a goal naming the AGI produced a session with
 * `kortixCli: []` that 403'd on every `kortix` call, so the scheduled push could
 * not run the agent whose loop it encodes. `kortix-agi` now resolves through a
 * dedicated path instead.
 *
 * The load-bearing claim is NOT that the AGI resolves — it is that nothing else
 * moved. A reserved name is only safe if it is exactly one literal, so these
 * tests spend most of their weight on the negative space: undeclared non-AGI
 * names, near-miss spellings, and the declared-agents-required gate.
 *
 * Pure resolution rules, no I/O — everything runs off a hand-built LoadedAgents.
 */
import { describe, expect, test } from 'bun:test';
import {
  AGI_AGENT_NAME,
  type AgentSpec,
  DEFAULT_AGENT_SENTINEL,
  type LoadedAgents,
  agiAgentGrant,
  grantFromLoadedAgents,
  isAgiAgentName,
  resolveGovernedAgentGrant,
} from './agents';

const spec = (name: string, over: Partial<AgentSpec> = {}): AgentSpec => ({
  name,
  path: `kortix.yaml#agents.${name}`,
  enabled: true,
  connectors: [],
  kortixCli: [],
  env: [],
  file: null,
  model: null,
  ...over,
});

/** A project that HAS adopted `agents:` — the case where an unlisted name is
 *  default-denied, and therefore the only case where the AGI branch is visible
 *  at all. */
const governed = (over: Partial<LoadedAgents> = {}): LoadedAgents => ({
  specs: [spec('release-bot', { kortixCli: ['project.cr.open'], connectors: ['github'] })],
  errors: [],
  defaultAgent: null,
  ...over,
});

/** A project that never adopted `agents:` — every name already resolves to the
 *  permissive null grant here. */
const ungoverned = (): LoadedAgents => ({ specs: [], errors: [], defaultAgent: null });

describe('the reserved name is exactly one literal', () => {
  test('only the exact spelling is the AGI', () => {
    expect(isAgiAgentName(AGI_AGENT_NAME)).toBe(true);
    expect(AGI_AGENT_NAME).toBe('kortix-agi');

    for (const near of [
      'agi',
      'kortix',
      'KORTIX-AGI',
      'kortix-agi-2',
      'kortix_agi',
      ' kortix-agi',
    ]) {
      expect(isAgiAgentName(near)).toBe(false);
    }
  });

  test('a near-miss name is an ordinary undeclared agent and still default-denies', () => {
    for (const near of ['agi', 'KORTIX-AGI', 'kortix-agi-2', 'kortix_agi']) {
      expect(grantFromLoadedAgents(near, governed())).toEqual({
        agent: near,
        kortixCli: [],
        connectors: [],
        env: [],
      });
    }
  });
});

describe('R-39 — the AGI grant is the launching principal and no more', () => {
  test('kortixCli and connectors are "all", which the route layer intersects with the principal', () => {
    // "all" is not unbounded on these two: every route re-checks the principal's
    // role, so `all` collapses to exactly what that principal could do itself.
    const grant = agiAgentGrant();
    expect(grant.agent).toBe(AGI_AGENT_NAME);
    expect(grant.kortixCli).toBe('all');
    expect(grant.connectors).toBe('all');
  });

  test('env is DENIED, because secret injection has no second role check to cap it', () => {
    // The one dimension where "all" would exceed the launching principal: no
    // route ever returns a secret value to a human, so this grant field is the
    // ONLY thing standing between a project credential and a shell the caller
    // controls. A project whose declared agents all carry narrow `secrets`
    // allowlists must not be openable by naming the AGI.
    expect(agiAgentGrant().env).toEqual([]);
  });

  test('each call returns a fresh object, so a stored grant cannot be mutated back', () => {
    const first = agiAgentGrant();
    first.kortixCli = [];
    expect(agiAgentGrant().kortixCli).toBe('all');
  });
});

describe('R-35 — the AGI resolves without a manifest entry', () => {
  test('a governed project grants it in full where an undeclared name is denied', () => {
    expect(grantFromLoadedAgents(AGI_AGENT_NAME, governed())).toEqual(agiAgentGrant());
    // The contrast is the point: same manifest, same call, opposite answer.
    expect(grantFromLoadedAgents('ghost', governed())).toEqual({
      agent: 'ghost',
      kortixCli: [],
      connectors: [],
      env: [],
    });
  });

  test('a manifest cannot shadow, narrow, or disable it', () => {
    const shadowed = governed({
      specs: [spec(AGI_AGENT_NAME, { kortixCli: [], connectors: [], env: [] })],
    });
    expect(grantFromLoadedAgents(AGI_AGENT_NAME, shadowed)).toEqual(agiAgentGrant());

    const disabled = governed({ specs: [spec(AGI_AGENT_NAME, { enabled: false })] });
    expect(grantFromLoadedAgents(AGI_AGENT_NAME, disabled)).toEqual(agiAgentGrant());
  });

  test('a manifest cannot widen some other agent into the AGI either', () => {
    const impostor = governed({
      specs: [spec('kortix-agi-impostor', { kortixCli: 'all', connectors: 'all', env: 'all' })],
    });
    // Declaring an agent "all" is already allowed — this asserts only that the
    // impostor keeps its OWN identity on the grant, so an audit of AGI runs
    // cannot be polluted by a manifest-declared name.
    expect(grantFromLoadedAgents('kortix-agi-impostor', impostor)?.agent).toBe(
      'kortix-agi-impostor',
    );
  });

  test('a manifest default_agent may point at it', () => {
    const loaded = governed({ defaultAgent: AGI_AGENT_NAME });
    expect(grantFromLoadedAgents(DEFAULT_AGENT_SENTINEL, loaded)).toEqual(agiAgentGrant());
  });
});

describe('existing resolution is unchanged', () => {
  test('a declared agent still gets its declared overlay', () => {
    expect(grantFromLoadedAgents('release-bot', governed())).toEqual({
      agent: 'release-bot',
      kortixCli: ['project.cr.open'],
      connectors: ['github'],
      env: [],
    });
  });

  test('a disabled declared agent still default-denies', () => {
    const loaded = governed({ specs: [spec('release-bot', { enabled: false })] });
    expect(grantFromLoadedAgents('release-bot', loaded)).toEqual({
      agent: 'release-bot',
      kortixCli: [],
      connectors: [],
      env: [],
    });
  });

  test('an ungoverned project still returns the permissive null for every non-AGI name', () => {
    expect(grantFromLoadedAgents('anything', ungoverned())).toBeNull();
    expect(grantFromLoadedAgents(DEFAULT_AGENT_SENTINEL, ungoverned())).toBeNull();
  });

  test('the default sentinel still resolves to a v2 manifest default_agent', () => {
    const loaded = governed({
      specs: [spec('kortix', { kortixCli: 'all', connectors: 'all', env: 'all' })],
      defaultAgent: 'kortix',
    });
    expect(grantFromLoadedAgents(DEFAULT_AGENT_SENTINEL, loaded)).toEqual({
      agent: 'kortix',
      kortixCli: 'all',
      connectors: 'all',
      env: 'all',
    });
  });

  test('the default sentinel still falls through to null when default_agent does not resolve', () => {
    expect(grantFromLoadedAgents(DEFAULT_AGENT_SENTINEL, governed())).toBeNull();
    expect(
      grantFromLoadedAgents(DEFAULT_AGENT_SENTINEL, governed({ defaultAgent: 'missing' })),
    ).toBeNull();
  });

  test('a manifest that only produced parse errors still default-denies', () => {
    const broken: LoadedAgents = {
      specs: [],
      errors: [{ name: '(top-level)', path: 'kortix.yaml', error: 'boom' }],
      defaultAgent: null,
    };
    expect(grantFromLoadedAgents('whoever', broken)).toEqual({
      agent: 'whoever',
      kortixCli: [],
      connectors: [],
      env: [],
    });
  });
});

describe('projectRequiresDeclaredAgents still gates everything else', () => {
  const subject = { subject: true, projectDefaultAgent: null };

  test('the AGI resolves under enforcement — the platform is what declares it', () => {
    expect(resolveGovernedAgentGrant(AGI_AGENT_NAME, governed(), subject)).toEqual({
      ok: true,
      grant: agiAgentGrant(),
    });
  });

  test('every other undeclared name is still rejected, near-misses included', () => {
    for (const name of ['ghost', 'agi', 'kortix-agi-2', 'KORTIX-AGI']) {
      const result = resolveGovernedAgentGrant(name, governed(), subject);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.code).toBe('AGENT_NOT_DECLARED');
    }
  });

  test('a declared agent still resolves to its declared overlay', () => {
    expect(resolveGovernedAgentGrant('release-bot', governed(), subject)).toEqual({
      ok: true,
      grant: {
        agent: 'release-bot',
        kortixCli: ['project.cr.open'],
        connectors: ['github'],
        env: [],
      },
    });
  });

  test('a disabled declared agent is still rejected', () => {
    const loaded = governed({ specs: [spec('release-bot', { enabled: false })] });
    const result = resolveGovernedAgentGrant('release-bot', loaded, subject);
    expect(result.ok).toBe(false);
  });

  test('the sentinel still requires a resolvable default_agent', () => {
    const missing = resolveGovernedAgentGrant(DEFAULT_AGENT_SENTINEL, governed(), subject);
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.error).toContain('no default_agent configured');

    const dangling = resolveGovernedAgentGrant(DEFAULT_AGENT_SENTINEL, governed(), {
      subject: true,
      projectDefaultAgent: 'gone',
    });
    expect(dangling.ok).toBe(false);
    expect(dangling.ok === false && dangling.error).toContain('is not declared');
  });

  test('the sentinel may resolve to the AGI when the project names it as default', () => {
    expect(
      resolveGovernedAgentGrant(DEFAULT_AGENT_SENTINEL, governed(), {
        subject: true,
        projectDefaultAgent: AGI_AGENT_NAME,
      }),
    ).toEqual({ ok: true, grant: agiAgentGrant() });

    expect(
      resolveGovernedAgentGrant(
        DEFAULT_AGENT_SENTINEL,
        governed({ defaultAgent: AGI_AGENT_NAME }),
        subject,
      ),
    ).toEqual({ ok: true, grant: agiAgentGrant() });
  });

  test('a non-subject project still mirrors grantFromLoadedAgents exactly', () => {
    const loaded = governed({ defaultAgent: 'release-bot' });
    for (const name of ['release-bot', 'ghost', DEFAULT_AGENT_SENTINEL, AGI_AGENT_NAME]) {
      expect(
        resolveGovernedAgentGrant(name, loaded, { subject: false, projectDefaultAgent: null }),
      ).toEqual({ ok: true, grant: grantFromLoadedAgents(name, loaded) });
    }
  });
});
