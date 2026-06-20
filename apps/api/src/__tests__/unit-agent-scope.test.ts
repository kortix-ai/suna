/**
 * Tests for the per-agent authorization layer: the grant-resolution rule
 * (grantFromLoadedAgents) and the enforcement helpers (agentMayPerform,
 * agentMayUseConnector, assertAgentScope). These are the heart of the security
 * update — a scoped agent is denied actions/connectors it wasn't granted, and
 * agent ≤ user is preserved (the route's role check provides the ∩ user).
 */
import { describe, expect, test } from 'bun:test';
import { extractAgents, grantFromLoadedAgents } from '../projects/agents';
import { agentMayPerform, agentMayUseConnector, assertAgentScope } from '../iam/agent-scope';
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
    });
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
