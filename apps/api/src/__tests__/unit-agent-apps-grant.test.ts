/**
 * `agents.<a>.apps` — the per-agent App grant (spec
 * docs/specs/2026-09-22-agents-as-principals.md §2.5), from manifest text to
 * the stored `AgentGrant` and the gate predicate `agentMayOpenApp`.
 *
 * Default is NONE in both manifest versions. An agent that declares no Apps
 * resolves to a grant WITHOUT the `apps` key, so grants minted before the field
 * existed and grants of agents that never mention Apps read the same way.
 */
import { describe, expect, test } from 'bun:test';
import {
  agentSpecToTomlEntry,
  extractAgents,
  grantFromLoadedAgents,
  resolveGovernedAgentGrant,
} from '../projects/agents';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';
import { agentGrantDiffers } from '../projects/lib/secret-grant';
import { agentMayOpenApp } from '../iam/agent-scope';

function parseV2(agentsBody: string) {
  const text = ['kortix_version: 2', 'default_agent: reporter', 'project:', '  name: test', 'agents:', agentsBody].join('\n');
  return extractAgents(parseManifestString(text, 'yaml', 'kortix.yaml'));
}

function parseV1(body: string) {
  return extractAgents(
    parseManifestString([`kortix_version = ${KNOWN_SCHEMA_VERSION}`, '[project]', 'name = "test"', body].join('\n')),
  );
}

describe('manifest → AgentSpec.apps', () => {
  test('v2: an explicit slug list, "all", "none", and omitted', () => {
    const { specs, errors } = parseV2(`
  reporter:
    apps: [finance-dashboards]
  admin:
    apps: all
  closed:
    apps: none
  quiet: {}
`);
    expect(errors).toEqual([]);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s.apps]));
    expect(byName).toEqual({ reporter: ['finance-dashboards'], admin: 'all', closed: [], quiet: [] });
  });

  test('v1: [[agents]] apps parses with the same grant-set forms; omitted = none', () => {
    const { specs, errors } = parseV1(`
[[agents]]
name = "reporter"
apps = ["finance-dashboards"]

[[agents]]
name = "quiet"
`);
    expect(errors).toEqual([]);
    expect(specs.find((s) => s.name === 'reporter')?.apps).toEqual(['finance-dashboards']);
    expect(specs.find((s) => s.name === 'quiet')?.apps).toEqual([]);
  });

  test('v1: a malformed apps value is a parse error for that agent', () => {
    const { errors } = parseV1(`
[[agents]]
name = "reporter"
apps = "everything"
`);
    expect(errors.map((e) => e.name)).toEqual(['reporter']);
  });

  test('round-trip: agentSpecToTomlEntry emits apps only when declared', () => {
    const { specs } = parseV1(`
[[agents]]
name = "reporter"
apps = ["finance-dashboards"]

[[agents]]
name = "quiet"
`);
    expect(agentSpecToTomlEntry(specs.find((s) => s.name === 'reporter')!).apps).toEqual(['finance-dashboards']);
    expect('apps' in agentSpecToTomlEntry(specs.find((s) => s.name === 'quiet')!)).toBe(false);
  });
});

describe('AgentSpec → AgentGrant', () => {
  const loaded = parseV2(`
  reporter:
    kortix_permissions: [project.app.read]
    apps: [finance-dashboards]
  bystander:
    kortix_permissions: [project.app.read]
`);

  test('a declared apps list reaches the grant', () => {
    expect(grantFromLoadedAgents('reporter', loaded)?.apps).toEqual(['finance-dashboards']);
    expect(grantFromLoadedAgents('default', loaded)?.apps).toEqual(['finance-dashboards']);
  });

  test('an agent without apps gets a grant without the key (absent = none)', () => {
    const grant = grantFromLoadedAgents('bystander', loaded)!;
    expect('apps' in grant).toBe(false);
  });

  test('an unlisted agent in a governed project gets no apps', () => {
    const grant = grantFromLoadedAgents('stranger', loaded)!;
    expect(agentMayOpenApp(grant, 'finance-dashboards')).toBe(false);
  });

  test('resolveGovernedAgentGrant carries apps too', () => {
    const r = resolveGovernedAgentGrant('reporter', loaded, { subject: true, projectDefaultAgent: null });
    expect(r.ok && r.grant?.apps).toEqual(['finance-dashboards']);
    const d = resolveGovernedAgentGrant('default', loaded, { subject: true, projectDefaultAgent: null });
    expect(d.ok && d.grant?.apps).toEqual(['finance-dashboards']);
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
