/**
 * `agents.<a>.apps` — the per-agent App grant, from manifest text to
 * the stored `AgentGrant` and the gate predicate `agentMayOpenApp`.
 *
 * Default is NONE. An agent that declares no Apps
 * resolves to a grant WITHOUT the `apps` key, so grants minted before the field
 * existed and grants of agents that never mention Apps read the same way.
 */
import { describe, expect, test } from 'bun:test';
import {
  extractAgents,
  grantFromLoadedAgents,
  resolveGovernedAgentGrant,
} from '../projects/agents';
import { parseManifestString } from '../projects/triggers';
import { agentGrantDiffers } from '../projects/lib/secret-grant';
import { agentMayOpenApp } from '../iam/agent-scope';

function parseV2(agentsBody: string) {
  const text = ['default_agent: reporter', 'project:', '  name: test', 'agents:', agentsBody].join('\n');
  return extractAgents(parseManifestString(text, 'kortix.yaml'));
}

describe('manifest → AgentSpec.apps', () => {
  test('an explicit slug list, "all", "none", and omitted', () => {
    const { specs, errors } = parseV2(`
  reporter:
    apps: [reports-dashboard]
  admin:
    apps: all
  closed:
    apps: none
  quiet: {}
`);
    expect(errors).toEqual([]);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s.apps]));
    expect(byName).toEqual({ reporter: ['reports-dashboard'], admin: 'all', closed: [], quiet: [] });
  });
});

describe('AgentSpec → AgentGrant', () => {
  const loaded = parseV2(`
  reporter:
    kortix_permissions: [project.app.read]
    apps: [reports-dashboard]
  bystander:
    kortix_permissions: [project.app.read]
`);

  test('a declared apps list reaches the grant', () => {
    expect(grantFromLoadedAgents('reporter', loaded)?.apps).toEqual(['reports-dashboard']);
    expect(grantFromLoadedAgents('default', loaded)?.apps).toEqual(['reports-dashboard']);
  });

  test('an agent without apps gets a grant without the key (absent = none)', () => {
    const grant = grantFromLoadedAgents('bystander', loaded)!;
    expect('apps' in grant).toBe(false);
  });

  test('an unlisted agent in a governed project gets no apps', () => {
    const grant = grantFromLoadedAgents('stranger', loaded)!;
    expect(agentMayOpenApp(grant, 'reports-dashboard')).toBe(false);
  });

  test('resolveGovernedAgentGrant carries apps too', () => {
    const r = resolveGovernedAgentGrant('reporter', loaded, { subject: true, projectDefaultAgent: null });
    expect(r.ok && r.grant?.apps).toEqual(['reports-dashboard']);
    const d = resolveGovernedAgentGrant('default', loaded, { subject: true, projectDefaultAgent: null });
    expect(d.ok && d.grant?.apps).toEqual(['reports-dashboard']);
  });
});

describe('agentGrantDiffers sees an apps change (so the token is re-minted)', () => {
  const base = { agent: 'a', permissions: ['project.app.read'], connectors: [], env: [] } as const;
  test('absent and [] are the same grant', () => {
    expect(agentGrantDiffers({ ...base, permissions: [...base.permissions], connectors: [], env: [] },
      { ...base, permissions: [...base.permissions], connectors: [], env: [], apps: [] })).toBe(false);
  });
  test('adding an App is a change', () => {
    expect(agentGrantDiffers({ ...base, permissions: [...base.permissions], connectors: [], env: [] },
      { ...base, permissions: [...base.permissions], connectors: [], env: [], apps: ['x'] })).toBe(true);
  });
  test('"all" differs from a list', () => {
    expect(agentGrantDiffers({ ...base, permissions: [...base.permissions], connectors: [], env: [], apps: 'all' },
      { ...base, permissions: [...base.permissions], connectors: [], env: [], apps: ['x'] })).toBe(true);
  });
});

describe('agentMayOpenApp', () => {
  const g = (apps?: string[] | 'all') => ({ agent: 'a', permissions: [], connectors: [], ...(apps !== undefined ? { apps } : {}) });
  test('absent = none', () => expect(agentMayOpenApp(g(), 'x')).toBe(false));
  test('empty list = none', () => expect(agentMayOpenApp(g([]), 'x')).toBe(false));
  test('listed slug', () => expect(agentMayOpenApp(g(['x']), 'x')).toBe(true));
  test('unlisted slug', () => expect(agentMayOpenApp(g(['x']), 'y')).toBe(false));
  test('"all"', () => expect(agentMayOpenApp(g('all'), 'y')).toBe(true));
  test('"*" in a list means all', () => expect(agentMayOpenApp(g(['*']), 'y')).toBe(true));
  test('a missing slug never matches a list', () => expect(agentMayOpenApp(g(['x']), null)).toBe(false));
  test('slug match is case-insensitive (App slugs are lowercase)', () => expect(agentMayOpenApp(g(['x']), 'X')).toBe(true));
});
