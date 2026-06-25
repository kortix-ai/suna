/**
 * Tests for the per-agent authorization layer: the grant-resolution rule
 * (grantFromLoadedAgents) and the enforcement helpers (agentMayPerform,
 * agentMayUseConnector, assertAgentScope). These are the heart of the security
 * update — a scoped agent is denied actions/connectors it wasn't granted, and
 * agent ≤ user is preserved (the route's role check provides the ∩ user).
 */
import { describe, expect, test } from 'bun:test';
import { extractAgents, grantFromLoadedAgents } from '../projects/agents';
import { agentMayPerform, agentMayUseConnector, agentMayUseEnv, assertAgentScope } from '../iam/agent-scope';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';

function loadAgents(body: string) {
  return extractAgents(parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}\n[project]\nname="t"\n${body}`));
}

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
kortix_cli = ["project.deploy", "project.cr.open"]
`);
    expect(grantFromLoadedAgents('release-bot', loaded)).toEqual({
      agent: 'release-bot',
      connectors: ['github'],
      kortixCli: ['project.deploy', 'project.cr.open'],
      env: 'all', // env key omitted → defaults to 'all' (back-compat for the new dimension)
    });
  });

  test('governance adopted but agent unlisted → default-deny ([],[])', () => {
    const loaded = loadAgents(`
[[agents]]
name = "release-bot"
kortix_cli = ["project.deploy"]
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
kortix_cli = ["project.deploy"]
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
  test('non-granted action → denied (the cr.open-but-not-merge case)', () => {
    const grant = { agent: 'a', kortixCli: ['project.cr.open'], connectors: [] };
    expect(agentMayPerform(grant, 'project.cr.merge')).toBe(false);
  });
  test('empty grant → everything denied', () => {
    expect(agentMayPerform({ agent: 'a', kortixCli: [], connectors: [] }, 'project.deploy')).toBe(false);
  });
  test('cr.open ≡ gitops.push alias: holding either satisfies the other (no double-gate)', () => {
    const crOnly = { agent: 'a', kortixCli: ['project.cr.open'], connectors: [] };
    expect(agentMayPerform(crOnly, 'project.gitops.push')).toBe(true); // fold gates the commit as gitops.push
    const pushOnly = { agent: 'a', kortixCli: ['project.gitops.push'], connectors: [] };
    expect(agentMayPerform(pushOnly, 'project.cr.open')).toBe(true); // route gates CR-create as cr.open
    // merge pair is independent — cr.open does NOT unlock merge
    expect(agentMayPerform(crOnly, 'project.gitops.merge')).toBe(false);
    expect(agentMayPerform(crOnly, 'project.cr.merge')).toBe(false);
  });
  test('cr.merge ≡ gitops.merge alias', () => {
    const mergeOnly = { agent: 'a', kortixCli: ['project.cr.merge'], connectors: [] };
    expect(agentMayPerform(mergeOnly, 'project.gitops.merge')).toBe(true);
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
    const c = fakeCtx({ agent: 'a', kortixCli: ['project.cr.open'], connectors: [] });
    expect(() => assertAgentScope(c, 'project.cr.merge')).toThrow();
  });
  test('does not throw for a granted action', () => {
    const c = fakeCtx({ agent: 'a', kortixCli: ['project.cr.open'], connectors: [] });
    expect(() => assertAgentScope(c, 'project.cr.open')).not.toThrow();
  });
  test('does not throw when there is no grant (human / laptop CLI)', () => {
    const c = fakeCtx(null);
    expect(() => assertAgentScope(c, 'project.cr.merge')).not.toThrow();
  });
});
