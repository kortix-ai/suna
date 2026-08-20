/**
 * Tests for the per-agent authorization layer: the grant-resolution rule
 * (grantFromLoadedAgents) and the enforcement helpers (agentMayPerform,
 * agentMayUseConnector, assertAgentScope). These are the heart of the security
 * update — a scoped agent is denied actions/connectors it wasn't granted, and
 * agent ≤ user is preserved (the route's role check provides the ∩ user).
 */
import { describe, expect, test } from 'bun:test';
import { extractAgents, grantFromLoadedAgents } from '../projects/agents';
import {
  agentMayPerform,
  canonicalizeGrantActions,
  agentMayUseConnector,
  agentMayUseEnv,
  assertAgentScope,
  isProjectSessionPrincipal,
} from '../iam/agent-scope';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';

function loadAgents(body: string) {
  return extractAgents(parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}\n[project]\nname="t"\n${body}`));
}

describe('isProjectSessionPrincipal', () => {
  const context = (values: Record<string, unknown>) =>
    ({ get: (key: string) => values[key] }) as never;

  test('does not treat a Supabase auth session as a project session', () => {
    expect(
      isProjectSessionPrincipal(
        context({ authType: 'supabase', sessionId: 'supabase-auth-session' }),
      ),
    ).toBe(false);
  });

  test('recognizes a project-scoped token session', () => {
    expect(
      isProjectSessionPrincipal(context({ authType: 'pat', sessionId: 'project-session' })),
    ).toBe(true);
  });
});

describe('grantFromLoadedAgents — resolution rule', () => {
  test('no [[agents]] section → null (no restriction, backward-compatible)', () => {
    const grant = grantFromLoadedAgents('default', loadAgents(''));
    expect(grant).toBeNull();
  });

  test('listed agent → its declared grant', () => {
    const loaded = loadAgents(`
[[agents]]
name = "release-bot"
connectors = ["github"]
kortix_cli = ["project.trigger.create", "project.cr.open"]
`);
    expect(grantFromLoadedAgents('release-bot', loaded)).toEqual({
      agent: 'release-bot',
      connectors: ['github'],
      // `project.cr.open` in the manifest, `project.gitops.push` here:
      // `grantFromLoadedAgents` normalizes the retired spelling on the way out.
      kortixCli: ['project.trigger.create', 'project.gitops.push'],
      env: 'all', // env key omitted → defaults to 'all' (back-compat for the new dimension)
    });
  });

  test('governance adopted but agent unlisted → default-deny ([],[])', () => {
    const loaded = loadAgents(`
[[agents]]
name = "release-bot"
kortix_cli = ["project.trigger.create"]
`);
    expect(grantFromLoadedAgents('some-other-agent', loaded)).toEqual({
      agent: 'some-other-agent',
      connectors: [],
      kortixCli: [],
      env: [], // unlisted-but-adopted → default-deny everything, incl. secrets
    });
  });

  test('disabled agent is treated as unlisted → default-deny', () => {
    const loaded = loadAgents(`
[[agents]]
name = "release-bot"
enabled = false
kortix_cli = ["project.trigger.create"]
`);
    expect(grantFromLoadedAgents('release-bot', loaded)).toEqual({
      agent: 'release-bot',
      connectors: [],
      kortixCli: [],
      env: [],
    });
  });

  test('default kortix agent declared with "all" → grants all', () => {
    const loaded = loadAgents(`
[[agents]]
name = "kortix"
connectors = "all"
kortix_cli = "all"
`);
    expect(grantFromLoadedAgents('kortix', loaded)).toEqual({
      agent: 'kortix',
      connectors: 'all',
      kortixCli: 'all',
      env: 'all',
    });
  });

  // Regression: a session that boots with the non-binding `default` sentinel in a
  // GOVERNED project must NOT be default-denied. No agent is ever named `default`
  // — the runtime resolves it to the configured `default_agent` (a GP agent), so
  // default-denying it stripped every connector and made `kortix connectors
  // connectors` return [] (and hid synthetic channel/computer connectors). The
  // sentinel is non-binding → null (no restriction, still capped at the user).
  test('`default` sentinel under governance → null (non-binding), not default-deny', () => {
    const loaded = loadAgents(`
[[agents]]
name = "veyris"
connectors = "all"
kortix_cli = "all"

[[agents]]
name = "memory-reflector"
connectors = []
`);
    expect(grantFromLoadedAgents('default', loaded)).toBeNull();
  });

  // The security feature is preserved: an unlisted CONCRETE agent still denies.
  // Default-deny is total — no connectors, no Kortix-CLI, and (per the secrets-
  // scoping rule) no project env either.
  test('concrete unlisted agent under governance still default-denies (≠ sentinel)', () => {
    const loaded = loadAgents(`
[[agents]]
name = "veyris"
connectors = "all"
`);
    expect(grantFromLoadedAgents('rogue-agent', loaded)).toEqual({
      agent: 'rogue-agent',
      connectors: [],
      kortixCli: [],
      env: [],
    });
  });
});

// kortix_version 2 — the manifest's own top-level `default_agent` MUST resolve
// the `default` sentinel to a concrete declared agent's grant (spec §2.1),
// the opposite of v1's "sentinel is non-binding → null" rule tested above.
// `loaded.defaultAgent` is what carries this from `extractAgents` — it's
// always null for a v1 manifest, so the v1 tests above are unaffected.
describe('grantFromLoadedAgents — v2 `default_agent` sentinel resolution', () => {
  function loadAgentsV2(agentsBody: string, opts: { defaultAgent?: string } = {}) {
    const text = [
      'kortix_version: 2',
      `default_agent: ${opts.defaultAgent ?? 'support'}`,
      'project:',
      '  name: t',
      'agents:',
      agentsBody,
    ].join('\n');
    return extractAgents(parseManifestString(text, 'yaml', 'kortix.yaml'));
  }

  test('sentinel resolves to the declared default_agent\'s grant, not null', () => {
    const loaded = loadAgentsV2(`
  support:
    connectors: [github]
    kortix_cli: [project.cr.open]
`);
    expect(grantFromLoadedAgents('default', loaded)).toEqual({
      agent: 'support',
      connectors: ['github'],
      kortixCli: ['project.gitops.push'], // normalized from the manifest's cr.open
      env: [], // v2 deny-by-default (secrets omitted)
    });
  });

  test('a concrete declared v2 agent is found directly (not routed through the sentinel)', () => {
    const loaded = loadAgentsV2(`
  support:
    connectors: [github]
  billing:
    secrets: [STRIPE_KEY]
`);
    expect(grantFromLoadedAgents('billing', loaded)).toEqual({
      agent: 'billing',
      connectors: [],
      kortixCli: [],
      env: ['STRIPE_KEY'],
    });
  });

  test('default_agent naming a disabled/undeclared agent → sentinel falls through to null (unresolved, not a false grant)', () => {
    const loaded = loadAgentsV2(
      `
  support:
    enabled: false
`,
      { defaultAgent: 'support' },
    );
    expect(grantFromLoadedAgents('default', loaded)).toBeNull();
  });
});

describe('agentMayUseEnv — per-agent secret gate', () => {
  test('null grant → allowed (no restriction)', () => {
    expect(agentMayUseEnv(null, 'GITHUB_TOKEN')).toBe(true);
  });
  test('missing env (legacy grant) → treated as all', () => {
    expect(agentMayUseEnv({ agent: 'a', kortixCli: 'all', connectors: 'all' }, 'GITHUB_TOKEN')).toBe(true);
  });
  test('"all" → every secret allowed', () => {
    expect(agentMayUseEnv({ agent: 'a', kortixCli: [], connectors: [], env: 'all' }, 'STRIPE_KEY')).toBe(true);
  });
  test('explicit list → only listed secrets; others denied', () => {
    const grant = { agent: 'mkt', kortixCli: [], connectors: [], env: ['BRAND_API'] };
    expect(agentMayUseEnv(grant, 'BRAND_API')).toBe(true);
    expect(agentMayUseEnv(grant, 'STRIPE_KEY')).toBe(false);
  });
  test('empty list → no secrets', () => {
    expect(agentMayUseEnv({ agent: 'a', kortixCli: [], connectors: [], env: [] }, 'ANY')).toBe(false);
  });
  test('case-insensitive: a lowercase allowlist still admits the UPPERCASE secret', () => {
    // Secrets are canonically UPPERCASE; a hand-written kortix.yaml allowlist may not be.
    const grant = { agent: 'mkt', kortixCli: [], connectors: [], env: ['openai_api_key'] };
    expect(agentMayUseEnv(grant, 'OPENAI_API_KEY')).toBe(true);
    expect(agentMayUseEnv(grant, 'STRIPE_KEY')).toBe(false);
  });
});

describe('agentMayPerform — kortix_cli gate', () => {
  test('null grant (non-agent token) → allowed', () => {
    expect(agentMayPerform(null, 'project.cr.merge')).toBe(true);
  });
  test('"all" → allowed', () => {
    expect(agentMayPerform({ agent: 'kortix', kortixCli: 'all', connectors: 'all' }, 'project.cr.merge')).toBe(true);
  });
  test('granted action → allowed', () => {
    expect(agentMayPerform({ agent: 'a', kortixCli: ['project.cr.open'], connectors: [] }, 'project.cr.open')).toBe(true);
  });
  test('non-granted action → denied (the push-but-not-merge case)', () => {
    const grant = { agent: 'a', kortixCli: ['project.gitops.push'], connectors: [] };
    expect(agentMayPerform(grant, 'project.gitops.merge')).toBe(false);
  });
  test('empty grant → everything denied', () => {
    expect(agentMayPerform({ agent: 'a', kortixCli: [], connectors: [] }, 'project.trigger.create')).toBe(false);
  });
  // `project.cr.open` / `project.cr.merge` were the SAME capability as the
  // gitops leaves under a second name, and spec §2.4 collapsed them — neither is
  // in `kortix.permissions` any more. They are corrected on INPUT, once, when
  // the grant is resolved (`canonicalizeGrantActions`), not aliased at every
  // check. `agentMayPerform` is a plain membership test, so an UN-normalized
  // manifest spelling grants nothing: that is the point, and the reason the
  // normalization has its own test below.
  test('the retired cr.* spellings grant nothing once they reach the gate', () => {
    const crOnly = { agent: 'a', kortixCli: ['project.cr.open'], connectors: [] };
    expect(agentMayPerform(crOnly, 'project.gitops.push')).toBe(false);
    expect(agentMayPerform(crOnly, 'project.gitops.merge')).toBe(false);
  });
  test('canonicalizeGrantActions rewrites them to the catalog spelling', () => {
    expect(
      canonicalizeGrantActions({ agent: 'a', kortixCli: ['project.cr.open'], connectors: [] }),
    ).toEqual({ agent: 'a', kortixCli: ['project.gitops.push'], connectors: [] });
    expect(
      canonicalizeGrantActions({ agent: 'a', kortixCli: ['project.cr.merge'], connectors: [] }),
    ).toEqual({ agent: 'a', kortixCli: ['project.gitops.merge'], connectors: [] });
    // …and the two halves of a pair collapse to ONE entry, not a duplicate.
    expect(
      canonicalizeGrantActions({
        agent: 'a',
        kortixCli: ['project.cr.open', 'project.gitops.push'],
        connectors: [],
      })!.kortixCli,
    ).toEqual(['project.gitops.push']);
    // 'all' and null pass through untouched.
    expect(canonicalizeGrantActions(null)).toBeNull();
    expect(
      canonicalizeGrantActions({ agent: 'a', kortixCli: 'all', connectors: [] })!.kortixCli,
    ).toBe('all');
  });
  test('the merge pair stays independent of the push pair', () => {
    const pushOnly = { agent: 'a', kortixCli: ['project.gitops.push'], connectors: [] };
    expect(agentMayPerform(pushOnly, 'project.gitops.push')).toBe(true);
    expect(agentMayPerform(pushOnly, 'project.gitops.merge')).toBe(false);
  });
});

describe('agentMayUseConnector — connector gate', () => {
  test('null grant → allowed', () => {
    expect(agentMayUseConnector(null, 'github')).toBe(true);
  });
  test('"all" → allowed', () => {
    expect(agentMayUseConnector({ agent: 'k', kortixCli: 'all', connectors: 'all' }, 'salesforce')).toBe(true);
  });
  test('assigned connector → allowed; unassigned → denied', () => {
    const grant = { agent: 'a', kortixCli: [], connectors: ['github'] };
    expect(agentMayUseConnector(grant, 'github')).toBe(true);
    expect(agentMayUseConnector(grant, 'salesforce')).toBe(false);
  });
});

describe('assertAgentScope — throws 403 on deny', () => {
  function fakeCtx(grant: unknown) {
    return { get: (k: string) => (k === 'agentGrant' ? grant : undefined) } as any;
  }
  test('throws for a non-granted action', () => {
    const c = fakeCtx({ agent: 'a', kortixCli: ['project.gitops.push'], connectors: [] });
    expect(() => assertAgentScope(c, 'project.gitops.merge')).toThrow();
  });
  test('does not throw for a granted action', () => {
    const c = fakeCtx({ agent: 'a', kortixCli: ['project.gitops.push'], connectors: [] });
    expect(() => assertAgentScope(c, 'project.gitops.push')).not.toThrow();
  });
  test('does not throw when there is no grant (human / laptop CLI)', () => {
    const c = fakeCtx(null);
    expect(() => assertAgentScope(c, 'project.gitops.merge')).not.toThrow();
  });
});
