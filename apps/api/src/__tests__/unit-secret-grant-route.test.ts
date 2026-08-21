import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSecrets } from '@kortix/db';
import { Hono } from 'hono';
import { PROJECT_ACTIONS } from '../iam/actions';
import * as realAccess from '../projects/lib/access';
import * as realTriggers from '../projects/lib/triggers';
import { parseManifestString, synthesizeBlankManifest } from '../projects/triggers';
import type { ParsedManifest } from '../projects/triggers';

// POST /v1/projects/:projectId/secrets/:identifier/grant — the one-click fix
// for `delivery_blocked_reason: 'no_agent_grant'`. Every assertion here is on
// the wire contract plus the exact bytes handed to `commitManifest`, because
// the whole point of the route is what lands in kortix.yaml.

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';

// The `../iam` barrel is stubbed to keep its heavy dependency graph out of this
// unit test, but the action strings come from the REAL leaf — `iam/actions.ts`
// has no imports of its own, so there is no reason to hand-copy them. A
// hand-written subset silently resolves every unlisted key to `undefined`: the
// `project.secret.read` assertion this suite now pins read as `undefined` and
// the capability check passed while enforcing nothing.
mock.module('../iam', () => ({ PROJECT_ACTIONS }));

type SecretFixture = { identifier: string; ownerUserId: string | null; strategy: string };

let secretRows: SecretFixture[] = [];
// Assigned in beforeEach — the YAML fixtures below are still in their temporal
// dead zone at module-evaluation time.
let manifest!: ParsedManifest;
let manifestError: Error | null = null;
let commitFailure: { error: string; status: number } | null = null;
const commits: Array<{ message: string; raw: Record<string, unknown> }> = [];
const capabilities: string[] = [];

let authType: 'supabase' | 'pat' = 'supabase';
let sessionId: string | undefined;
let agentGrant: Record<string, unknown> | null = null;

const GOVERNED_YAML = `kortix_version: 2
default_agent: support
agents:
  support:
    connectors: [gmail]
    connectors_required: [gmail]
    kortix_cli: [project.cr.open]
    skills: all
    secrets: [OTHER_KEY]
  scout:
    kortix_cli: all
`;

const ALL_GRANT_YAML = `kortix_version: 2
default_agent: support
agents:
  support:
    secrets: all
`;

const UNGOVERNED_YAML = `kortix_version: 2
default_agent: support
project:
  name: demo
`;

const V1_TOML = `kortix_version = 1

[[agents]]
name = "support"
`;

function governedManifest(): ParsedManifest {
  return parseManifestString(GOVERNED_YAML, 'yaml', 'kortix.yaml', 'sha-governed');
}

function agentsOf(raw: Record<string, unknown>) {
  return raw.agents as Record<string, Record<string, unknown>>;
}

// The route's two reads differ only in their WHERE, which a drizzle double
// cannot inspect: `select` is the by-identifier lookup, `selectDistinct` is the
// project-wide identifier list. `requestedIdentifier` stands in for the first
// one's predicate; `grant()` sets it from the URL it is about to call.
let requestedIdentifier = '';

const databaseMock = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== projectSecrets) throw new Error('unexpected table');
      return { where: async () => secretRows.filter((row) => row.identifier === requestedIdentifier) };
    },
  }),
  selectDistinct: () => ({
    from: (table: unknown) => {
      if (table !== projectSecrets) throw new Error('unexpected table');
      return {
        where: async () =>
          [...new Set(secretRows.map((row) => row.identifier))].map((identifier) => ({ identifier })),
      };
    },
  }),
};

mock.module('../shared/db', () => ({ db: databaseMock, auditDb: databaseMock, hasDatabase: true }));
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, name: 'demo' },
    userId: USER_ID,
  }),
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    _accountId: string,
    _projectId: string,
    action: string,
  ) => {
    capabilities.push(action);
  },
}));
mock.module('../projects/lib/triggers', () => ({
  ...realTriggers,
  loadManifestForEdit: async () => {
    if (manifestError) throw manifestError;
    return manifest;
  },
  commitManifest: async (_project: unknown, edited: ParsedManifest, message: string) => {
    if (commitFailure) return commitFailure;
    commits.push({ message, raw: edited.raw });
    return { ok: true };
  },
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/agent-scope');

function buildApp() {
  const app = new Hono<{
    Variables: {
      userId: string;
      authType: 'supabase' | 'pat';
      sessionId?: string;
      agentGrant?: Record<string, unknown> | null;
    };
  }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', authType);
    if (sessionId) c.set('sessionId', sessionId);
    c.set('agentGrant', agentGrant);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function grant(identifier: string, agent: string) {
  requestedIdentifier = identifier;
  return buildApp().request(`/v1/projects/${PROJECT_ID}/secrets/${identifier}/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent }),
  });
}

describe('POST /v1/projects/:projectId/secrets/:identifier/grant', () => {
  beforeEach(() => {
    secretRows = [
      { identifier: 'BROKER_KEY', ownerUserId: null, strategy: 'broker' },
      { identifier: 'OTHER_KEY', ownerUserId: null, strategy: 'runtime' },
    ];
    manifest = governedManifest();
    manifestError = null;
    commitFailure = null;
    commits.length = 0;
    capabilities.length = 0;
    authType = 'supabase';
    sessionId = undefined;
    agentGrant = null;
  });

  test('merges into a declared agent and preserves every other governance field', async () => {
    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      identifier: 'BROKER_KEY',
      agent: 'support',
      already_granted: false,
      adopted_governance: false,
    });
    // BOTH leaves: the route writes the agent entry (`project.agent.write`) and
    // reads secret metadata to decide what to write, and the secrets surface is
    // gated separately on `project.secret.read`. Asserting the exact pair keeps
    // the read leaf from being dropped — without it the 404/409/200 split is an
    // existence oracle for a caller barred from the secrets list.
    expect(capabilities).toEqual(['project.agent.write', 'project.secret.read']);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message).toBe('chore(agents): grant BROKER_KEY to support');
    const support = agentsOf(commits[0]!.raw).support;
    expect(support.secrets).toEqual(['OTHER_KEY', 'BROKER_KEY']);
    expect(support.connectors).toEqual(['gmail']);
    expect(support.connectors_required).toEqual(['gmail']);
    expect(support.kortix_cli).toEqual(['project.cr.open']);
    expect(support.skills).toBe('all');
    // The other agent's block is untouched.
    expect(agentsOf(commits[0]!.raw).scout).toEqual({ kortix_cli: 'all' });
  });

  test('creates the entry for an agent the roster does not declare', async () => {
    const response = await grant('BROKER_KEY', 'newcomer');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agent: 'newcomer', already_granted: false });
    expect(agentsOf(commits[0]!.raw).newcomer).toEqual({ secrets: ['BROKER_KEY'] });
    expect(agentsOf(commits[0]!.raw).support.secrets).toEqual(['OTHER_KEY']);
  });

  test('reports adopted_governance on the manifest that gains its FIRST agents block', async () => {
    manifest = parseManifestString(UNGOVERNED_YAML, 'yaml', 'kortix.yaml', 'sha-ungoverned');

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ adopted_governance: true });
    expect(agentsOf(commits[0]!.raw)).toEqual({ support: { secrets: ['BROKER_KEY'] } });
  });

  test('reports adopted_governance when the repo carries no manifest at all', async () => {
    // What loadManifestForEdit synthesizes for a blank project: a `kortix`
    // agent with `secrets: all` and a null revision. Committing it publishes
    // the project's first roster, so the flag must fire.
    manifest = synthesizeBlankManifest({ name: 'demo', manifestPath: null });

    const response = await grant('BROKER_KEY', 'newcomer');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ adopted_governance: true });
    expect(agentsOf(commits[0]!.raw).newcomer).toEqual({ secrets: ['BROKER_KEY'] });
  });

  test('a second grant on an already-governed project does NOT adopt governance', async () => {
    const first = await grant('BROKER_KEY', 'support');
    expect(await first.json()).toMatchObject({ adopted_governance: false });

    manifest = parseManifestString(
      `kortix_version: 2\ndefault_agent: support\nagents:\n  support:\n    secrets: [BROKER_KEY]\n`,
      'yaml',
      'kortix.yaml',
      'sha-second',
    );
    const second = await grant('OTHER_KEY', 'support');

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ already_granted: false, adopted_governance: false });
    expect(agentsOf(commits[1]!.raw).support.secrets).toEqual(['BROKER_KEY', 'OTHER_KEY']);
  });

  test('an already-admitting list is idempotent and makes NO commit', async () => {
    const response = await grant('OTHER_KEY', 'support');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      identifier: 'OTHER_KEY',
      agent: 'support',
      already_granted: true,
      adopted_governance: false,
    });
    expect(commits).toHaveLength(0);
  });

  test('the admits check is case-insensitive, matching the delivery gate', async () => {
    manifest = parseManifestString(
      `kortix_version: 2\ndefault_agent: support\nagents:\n  support:\n    secrets: [broker_key]\n`,
      'yaml',
      'kortix.yaml',
      'sha-lowercase',
    );

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ already_granted: true });
    expect(commits).toHaveLength(0);
  });

  test("expands `secrets: all` instead of narrowing the agent to one identifier", async () => {
    manifest = parseManifestString(ALL_GRANT_YAML, 'yaml', 'kortix.yaml', 'sha-all');

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ already_granted: false });
    expect(agentsOf(commits[0]!.raw).support.secrets).toEqual(['OTHER_KEY', 'BROKER_KEY']);
  });

  test('a v1 manifest is a 400, never a 500', async () => {
    manifest = parseManifestString(V1_TOML, 'toml', 'kortix.toml', 'sha-v1');

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('manifest_v1_unsupported');
    expect(body.error).toContain('kortix.yaml');
    expect(commits).toHaveLength(0);
  });

  test('a denied secret is a 409 and never reaches the manifest', async () => {
    secretRows = [{ identifier: 'BROKER_KEY', ownerUserId: null, strategy: 'denied' }];

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'secret_not_grantable' });
    expect(commits).toHaveLength(0);
  });

  test('an unknown identifier is a 404', async () => {
    secretRows = [];

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(404);
    expect(commits).toHaveLength(0);
  });

  test('the shared row owns the delivery policy when a personal override exists', async () => {
    secretRows = [
      { identifier: 'BROKER_KEY', ownerUserId: USER_ID, strategy: 'runtime' },
      { identifier: 'BROKER_KEY', ownerUserId: null, strategy: 'denied' },
    ];

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'secret_not_grantable' });
  });

  test('an unreadable manifest is a 400, never a 500', async () => {
    manifestError = new Error('git mirror refresh failed');

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'manifest_read' });
  });

  test('an agent session cannot widen its own grant', async () => {
    authType = 'pat';
    sessionId = '55555555-5555-4555-8555-555555555555';

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'agent_session_forbidden' });
    expect(commits).toHaveLength(0);
  });

  test('rejects a malformed identifier and a blank agent before any read', async () => {
    // GrantSecretToAgentInputSchema trims, so both of these are rejected by the
    // route validator ahead of the handler — its own 400 envelope, not ours.
    expect((await grant('BROKER_KEY', '')).status).toBe(400);
    expect((await grant('BROKER_KEY', '   ')).status).toBe(400);

    const badIdentifier = await grant('bad id', 'support');
    expect(badIdentifier.status).toBe(400);
    expect(await badIdentifier.json()).toMatchObject({ code: 'invalid_identifier' });
    expect(commits).toHaveLength(0);
  });

  test('a body that is not JSON is a 400, never a 500', async () => {
    requestedIdentifier = 'BROKER_KEY';
    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/BROKER_KEY/grant`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' },
    );

    expect(response.status).toBe(400);
    expect(commits).toHaveLength(0);
  });

  test('an invalid agent NAME is a 400, not a broken manifest', async () => {
    const response = await grant('BROKER_KEY', 'Not A Slug');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_grant' });
    expect(commits).toHaveLength(0);
  });

  test('surfaces a commit conflict with its own status', async () => {
    commitFailure = { error: 'manifest changed', status: 409 };

    const response = await grant('BROKER_KEY', 'support');

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'manifest changed' });
  });
});
