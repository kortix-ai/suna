/**
 * Rule-set templates and the agent read models:
 *   - `PUT …/policy-sets/{name}` with `template`;
 *   - `GET …/connectors/{slug}/agents`;
 *   - `GET …/rules-matrix`.
 * Fake deps, no database.
 */
import { describe, expect, test } from 'bun:test';
import { createConnectorRouter, type ConnectorRouterDeps } from '../connectors/router';
import { likelyToolRisk, templatePolicies } from '../connectors/policy-templates';

const ADMIN = { 'x-test-admin': 'user-1', 'content-type': 'application/json' };
const ACTIONS = [
  { path: 'list_issues', risk: 'read' },
  { path: 'fetch_comments', risk: 'write' }, // a stored fallback `write` whose name says read
  { path: 'create_issue', risk: 'write' },
  { path: 'delete_issue', risk: 'destructive' },
  { path: 'ask_question', risk: 'write' }, // unknown by name
];
const MATRIX = {
  connectors: [{ slug: 'linear', name: 'Linear', policy_sets: ['triage'] }],
  agents: [
    { agent: 'ops', cells: { linear: { granted: true, policy_set: 'triage', policy_set_missing: false } } },
    { agent: 'writer', cells: { linear: { granted: false, policy_set: null, policy_set_missing: false } } },
  ],
};

function app(seen: unknown[] = []) {
  return createConnectorRouter({
    featureFlagEnabled: async () => false,
    resolvePrincipal: async () => null,
    resolveProjectPrincipal: async () => null,
    makeGatewayDeps: (() => ({})) as unknown as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async (c) => (c.req.header('x-test-admin') ? { accountId: 'acct-1', userId: 'user-1' } : null),
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    listConnectors: async () => [{ slug: 'linear', sensitive: false, actions: ACTIONS.map((a) => ({ ...a, name: a.path, description: '' })) }] as never,
    upsertConnectorPolicySet: async (_p, _a, slug, name, description, policies) => {
      seen.push({ upsert: { slug, name, description, ...(policies ? { policies } : {}) } });
      return { ok: true, created: true };
    },
    setConnectorPolicies: async (_p, _a, slug, policies, set) => {
      seen.push({ policies: { slug, set, policies } });
      return { ok: true };
    },
    getRulesMatrix: async () => MATRIX,
  } as ConnectorRouterDeps);
}

describe('likelyToolRisk', () => {
  test('a declared read or destructive stays; a fallback write takes the name; an HTTP method stays authoritative', () => {
    expect(likelyToolRisk('mcp', 'read_wiki_contents', 'write')).toBe('read');
    expect(likelyToolRisk('mcp', 'ask_wiki_question', 'write')).toBe('unknown');
    expect(likelyToolRisk('composio', 'send_email', 'write')).toBe('write');
    expect(likelyToolRisk('mcp', 'get_secret', 'destructive')).toBe('write');
    expect(likelyToolRisk('mcp', 'anything', 'read')).toBe('read');
    expect(likelyToolRisk('openapi', 'search_post', 'write')).toBe('write');
  });
});

describe('templatePolicies', () => {
  test('read_only blocks every tool that is not a read; ask_before_writes asks for them', () => {
    expect(templatePolicies('read_only', ACTIONS)).toEqual([
      { match: 'create_issue', action: 'block' },
      { match: 'delete_issue', action: 'block' },
      { match: 'ask_question', action: 'block' },
    ]);
    expect(templatePolicies('ask_before_writes', ACTIONS).map((p) => p.action)).toEqual(['require_approval', 'require_approval', 'require_approval']);
  });
});

describe('PUT …/policy-sets/{name} with a template', () => {
  test('creates the set with the template rules in one write', async () => {
    const seen: unknown[] = [];
    const res = await app(seen).fetch(
      new Request('http://x/projects/p1/connectors/linear/policy-sets/read_only', {
        method: 'PUT',
        headers: ADMIN,
        body: JSON.stringify({ description: 'Read, never write', template: 'read_only' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: true, template: 'read_only', rules: 3 });
    expect(seen).toEqual([
      {
        upsert: {
          slug: 'linear',
          name: 'read_only',
          description: 'Read, never write',
          policies: [
            { match: 'create_issue', action: 'block' },
            { match: 'delete_issue', action: 'block' },
            { match: 'ask_question', action: 'block' },
          ],
        },
      },
    ]);
  });

  test('an unknown template is 400 and writes nothing', async () => {
    const seen: unknown[] = [];
    const res = await app(seen).fetch(
      new Request('http://x/projects/p1/connectors/linear/policy-sets/x', { method: 'PUT', headers: ADMIN, body: JSON.stringify({ template: 'yolo' }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_template' });
    expect(seen).toEqual([]);
  });
});

describe('the agent read models', () => {
  test('a connector lists every agent: granted and its rule set', async () => {
    const res = await app().fetch(new Request('http://x/projects/p1/connectors/linear/agents', { headers: ADMIN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      slug: 'linear',
      policy_sets: ['triage'],
      agents: [
        { agent: 'ops', granted: true, policy_set: 'triage', policy_set_missing: false },
        { agent: 'writer', granted: false, policy_set: null, policy_set_missing: false },
      ],
    });
    expect((await app().fetch(new Request('http://x/projects/p1/connectors/github/agents', { headers: ADMIN }))).status).toBe(404);
  });

  test('the matrix is connectors × agents; admin only', async () => {
    const res = await app().fetch(new Request('http://x/projects/p1/rules-matrix', { headers: ADMIN }));
    expect(await res.json()).toEqual(MATRIX);
    expect((await app().fetch(new Request('http://x/projects/p1/rules-matrix'))).status).toBe(403);
  });
});
