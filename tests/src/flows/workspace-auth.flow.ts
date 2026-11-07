/**
 * One auth model for workspaces (`WS-AUTH-*`, design.md §3.2 C3, C4, C8).
 *
 *   - Membership IS access: joining a workspace reaches it, with no second grant.
 *   - One fence rule: a workspace key reaches every route of its own workspace,
 *     administration included, and nothing of another workspace.
 *   - The session policy covers every route of the workspace.
 *   - Agents: the person's role (inherited) or grant ∩ ceiling (governed),
 *     minus HUMAN_ONLY (minting credentials, moving money).
 *   - Act-as never writes IAM or deletes the workspace.
 *   - The /v1/workspaces IAM wire shows one scope.
 *
 * Black box: real HTTP and the real `kortix` CLI; the database is read and, for
 * the agent-session fixture and the idle clock, written (`requires: database`).
 * Generic synthetic data only.
 */
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { FlowContext, Principal } from '../core/types';
import { CliSandbox } from '../fixtures/cli';
import { AgentPrincipalsWorld, openDb } from '../fixtures/agent-principals';
import { PASSWORD } from '../fixtures/principals';
import { passwordGrantSession, refreshGrant } from '../fixtures/supabase';

const FENCE = 'credential_fence_refused';

/** A bearer principal for a raw key. */
const keyPrincipal = (base: Principal, token: string, label: string): Principal => ({ ...base, label, auth: { mode: 'bearer', token } });

async function mintWorkspaceKey(ctx: FlowContext, who: Principal, workspaceId: string, name: string): Promise<string> {
  const minted = await ctx.client.as(who).post(`/v1/workspaces/${workspaceId}/tokens`, {
    name,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  minted.status(201).body().has('$.project_id', workspaceId);
  return minted.json<{ secret_key: string }>().secret_key;
}

function expectFence(res: { statusCode: number; text(): string; json<T>(): T }, check: string, what: string): void {
  if (res.statusCode !== 403) throw new Error(`${what}: expected 403, got ${res.statusCode} ${res.text().slice(0, 200)}`);
  const body = res.json<{ code?: string; check?: string; message?: string }>();
  if (body.code !== FENCE || body.check !== check || !body.message?.startsWith('This workspace key cannot')) {
    throw new Error(`${what}: expected ${FENCE}/${check}, got ${res.text().slice(0, 300)}`);
  }
}

// ── WS-AUTH-1 — an accepted invite IS access to the workspace ───────────────
flow(
  'WS-AUTH-1',
  {
    domain: 'workspaces',
    routes: [
      'POST /v1/workspaces/:workspaceId/members',
      'POST /v1/accounts/:workspaceId/members',
      'GET /v1/workspaces/:workspaceId/members',
      'PATCH /v1/workspaces/:workspaceId/members/:userId',
      'POST /v1/invites/:inviteId/accept',
      'GET /v1/workspaces',
      'GET /v1/workspaces/:workspaceId',
      'GET /v1/workspaces/:workspaceId/sessions',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const opens = async (who: Principal) => {
      const listed = (await ctx.client.as(who).get('/v1/workspaces', { query: { account_id: team.id } })).status(200).json<any[]>();
      if (!listed.some((row) => row.workspace_id === w.id)) throw new Error('GET /v1/workspaces does not list the workspace');
      (await ctx.client.as(who).get(`/v1/workspaces/${w.id}`)).status(200);
      (await ctx.client.as(who).get(`/v1/workspaces/${w.id}/sessions`)).status(200);
    };

    await ctx.step('an existing user invited with {email} joins as member and opens the workspace, its sessions included', async () => {
      const person = await ctx.fixtures.user({ label: 'WSA1-EXISTING' });
      const added = await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, { email: person.email });
      added.status(201).body().has('$.status', 'added').has('$.role', 'member').has('$.account_role', 'member');
      if ((added.json<any>().project_grants as unknown[]).length !== 0) throw new Error('a second grant was written');
      await opens(person);
    });

    await ctx.step('a pending email accepts the invite and opens the workspace', async () => {
      const email = `${ctx.fixtures.name('wsa1-pending')}@example.test`.toLowerCase();
      const invited = await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, { email });
      invited.status(201).body().has('$.status', 'pending').has('$.role', 'member');
      const inviteId = invited.json<{ invite_id: string }>().invite_id;
      const invitee = await ctx.fixtures.userWithEmail(email, { label: 'WSA1-PENDING', noAccount: true });
      (await ctx.client.as(invitee).post(`/v1/invites/${inviteId}/accept`, {})).status(200).body().has('$.account_role', 'member');
      await opens(invitee);
    });

    await ctx.step('the ladder: a manager invite shows as manager; PATCH role member keeps access and drops the manager row', async () => {
      const person = await ctx.fixtures.user({ label: 'WSA1-MANAGER' });
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, { email: person.email, role: 'manager' }))
        .status(201).body().has('$.role', 'manager');
      const roleOf = async () =>
        (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}/members`)).status(200).json<any[]>()
          .find((m) => m.user_id === person.userId)?.role;
      if ((await roleOf()) !== 'manager') throw new Error(`members role ${await roleOf()}`);
      (await ctx.client.as(ctx.P.OWNER).patch(`/v1/workspaces/${w.id}/members/${person.userId}`, { role: 'member' }))
        .status(200).body().has('$.role', 'member');
      if ((await roleOf()) !== 'member') throw new Error(`members role after PATCH ${await roleOf()}`);
      await opens(person);
    });

    await ctx.step('project_grants naming another project on a 1:1 workspace → 400; owner on the canonical route → 400', async () => {
      const other = await ctx.fixtures.team();
      const p = await other.project();
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, {
        email: `${ctx.fixtures.name('wsa1-grant')}@example.test`.toLowerCase(),
        project_grants: [{ project_id: p.id, role: 'member' }],
      })).status(400);
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, {
        email: `${ctx.fixtures.name('wsa1-owner')}@example.test`.toLowerCase(),
        role: 'owner',
      })).status(400);
    });

    await ctx.step('a member of a split_pending legacy account still needs a project grant: canonical 404 workspace_not_found, legacy 403', async () => {
      const legacy = await ctx.fixtures.team();
      const a = await legacy.project();
      await legacy.project();
      const person = await ctx.fixtures.user({ label: 'WSA1-LEGACY' });
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/accounts/${legacy.id}/members`, { email: person.email })).status(201);
      (await ctx.client.as(person).get(`/v1/workspaces/${a.id}`)).status(404).body().has('$.code', 'workspace_not_found');
      (await ctx.client.as(person).get(`/v1/workspaces/${a.id}/sessions`)).status(404).body().has('$.code', 'workspace_not_found');
      (await ctx.client.as(person).get(`/v1/projects/${a.id}`)).status(403);
      (await ctx.client.as(person).get(`/v1/projects/${a.id}/sessions`)).status(403);
    });
  },
);

// ── WS-AUTH-2 — a workspace key administers its own workspace, no other ─────
flow(
  'WS-AUTH-2',
  {
    domain: 'workspaces',
    routes: [
      'POST /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/members',
      'GET /v1/workspaces/:workspaceId/invites',
      'GET /v1/workspaces/:workspaceId/iam/groups',
      'GET /v1/accounts/:workspaceId/members',
      'GET /v1/billing/account-state',
      'GET /v1/workspaces',
      'GET /v1/accounts',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const other = await ctx.fixtures.team();
    const q = await other.project();
    const key = keyPrincipal(ctx.P.OWNER, await mintWorkspaceKey(ctx, ctx.P.OWNER, w.id, 'wsa2-key'), 'WSA2_KEY');

    await ctx.step('own workspace: members, groups, keys, invites → 200 under both names', async () => {
      for (const tail of ['members', 'iam/groups', 'tokens', 'invites']) {
        (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/${tail}`)).status(200);
      }
      (await ctx.client.as(key).get(`/v1/accounts/${team.id}/members`)).status(200);
    });

    await ctx.step('own billing state answers as for the person; another workspace in account_id is fenced', async () => {
      const asPerson = await ctx.client.as(ctx.P.OWNER).get('/v1/billing/account-state', { query: { account_id: team.id } });
      const asKey = await ctx.client.as(key).get('/v1/billing/account-state', { query: { account_id: team.id } });
      if (asKey.statusCode !== asPerson.statusCode) throw new Error(`key ${asKey.statusCode} vs person ${asPerson.statusCode}`);
      if (asKey.statusCode === 403) throw new Error(`own billing refused: ${asKey.text().slice(0, 200)}`);
      expectFence(await ctx.client.as(key).get('/v1/billing/account-state', { query: { account_id: other.id } }), 'cross-workspace', 'foreign billing');
    });

    await ctx.step('another workspace: refused with credential_fence_refused / cross-workspace', async () => {
      expectFence(await ctx.client.as(key).get(`/v1/workspaces/${q.id}/members`), 'cross-workspace', 'foreign members');
      expectFence(await ctx.client.as(key).get(`/v1/accounts/${other.id}/members`), 'cross-workspace', 'foreign account members');
      expectFence(await ctx.client.as(key).get(`/v1/workspaces/${q.id}/sessions`), 'cross-workspace', 'foreign sessions');
    });

    await ctx.step('GET /v1/workspaces with the key lists only its workspace; GET /v1/accounts is a person route', async () => {
      const rows = (await ctx.client.as(key).get('/v1/workspaces')).status(200).json<any[]>();
      if (rows.length !== 1 || rows[0]?.workspace_id !== w.id) {
        throw new Error(`key listed ${JSON.stringify(rows.map((r) => r.workspace_id))}`);
      }
      expectFence(await ctx.client.as(key).get('/v1/accounts'), 'person-route', 'the account list');
    });
  },
);

// ── WS-AUTH-3 — a personal key acts as the person; a workspace key does not travel ─
flow(
  'WS-AUTH-3',
  {
    domain: 'workspaces',
    routes: ['POST /v1/accounts/tokens', 'POST /v1/workspaces/:workspaceId/tokens', 'GET /v1/workspaces/:workspaceId/members'],
  },
  async (ctx) => {
    const a = await (await ctx.fixtures.team()).project();
    const b = await (await ctx.fixtures.team()).project();

    await ctx.step('a personal key (project_id null) reaches A and B as the person', async () => {
      const minted = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', {
        name: 'wsa3-personal',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      minted.status(201).body().has('$.project_id', null);
      const personal = keyPrincipal(ctx.P.OWNER, minted.json<{ secret_key: string }>().secret_key, 'WSA3_PERSONAL');
      (await ctx.client.as(personal).get(`/v1/workspaces/${a.id}/members`)).status(200);
      (await ctx.client.as(personal).get(`/v1/workspaces/${b.id}/members`)).status(200);
    });

    await ctx.step('a workspace key minted in A is refused on B', async () => {
      const key = keyPrincipal(ctx.P.OWNER, await mintWorkspaceKey(ctx, ctx.P.OWNER, a.id, 'wsa3-a'), 'WSA3_A');
      (await ctx.client.as(key).get(`/v1/workspaces/${a.id}/members`)).status(200);
      expectFence(await ctx.client.as(key).get(`/v1/workspaces/${b.id}/members`), 'cross-workspace', 'B with the key of A');
    });
  },
);

// ── WS-AUTH-4 — the session policy covers every route of the workspace ──────
flow(
  'WS-AUTH-4',
  {
    domain: 'workspaces',
    requires: ['database'],
    routes: [
      'PATCH /v1/workspaces/:workspaceId/iam/session-policy',
      'GET /v1/workspaces/:workspaceId/iam/sessions',
      'POST /v1/workspaces/:workspaceId/iam/sessions/:sessionId/revoke',
      'GET /v1/workspaces/:workspaceId/sessions',
      'GET /v1/workspaces/:workspaceId/secrets',
      'PATCH /v1/workspaces/:workspaceId',
    ],
  },
  async (ctx) => {
    const db = await openDb(ctx);
    try {
      const team = await ctx.fixtures.team();
      // Git-backed: PATCH /workspaces/:w renames the config repo too.
      const w = await team.project({ managedGit: true });
      const email = `${ctx.fixtures.name('wsa4')}@example.test`.toLowerCase();
      const person = await ctx.fixtures.userWithEmail(email, { label: 'WSA4', noAccount: true });
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, { email, role: 'admin' })).status(201);
      // A session the flow owns, so it can also refresh it.
      const grant = await passwordGrantSession(ctx.env, email, PASSWORD);
      const sessionPrincipal = keyPrincipal(person, grant.accessToken, 'WSA4_SESSION');
      const routes = async (who: Principal) => [
        (await ctx.client.as(who).get(`/v1/workspaces/${w.id}/sessions`)).statusCode,
        (await ctx.client.as(who).get(`/v1/workspaces/${w.id}/secrets`)).statusCode,
        (await ctx.client.as(who).patch(`/v1/workspaces/${w.id}`, { name: ctx.fixtures.name('wsa4-renamed') })).statusCode,
      ];

      await ctx.step('with a 5-minute idle policy and a fresh session, data routes answer 200', async () => {
        (await ctx.client.as(ctx.P.OWNER).patch(`/v1/workspaces/${w.id}/iam/session-policy`, { idle_timeout_minutes: 5 })).status(200);
        const statuses = await routes(sessionPrincipal);
        if (statuses.some((s) => s !== 200)) throw new Error(`fresh session ${statuses.join(',')}`);
      });

      await ctx.step('the session idles past the limit (its activity row aged 10 minutes): 401 session_token_revoked on sessions, secrets and PATCH', async () => {
        const aged = await db.query(
          `UPDATE kortix.account_session_activity SET last_seen_at = now() - interval '10 minutes'
            WHERE account_id = $1 AND user_id = $2`,
          [team.id, person.userId],
        );
        if (!aged.rowCount) throw new Error('no activity row was written for the session');
        for (const path of [`/v1/workspaces/${w.id}/sessions`, `/v1/workspaces/${w.id}/secrets`]) {
          const r = await ctx.client.as(sessionPrincipal).get(path);
          r.status(401).body().has('$.code', 'session_token_revoked');
        }
        (await ctx.client.as(sessionPrincipal).patch(`/v1/workspaces/${w.id}`, { name: 'x' })).status(401);
      });

      await ctx.step('a refreshed token keeps the session id and stays 401', async () => {
        const refreshed = await refreshGrant(ctx.env, grant.refreshToken);
        const statuses = await routes(keyPrincipal(person, refreshed.accessToken, 'WSA4_REFRESHED'));
        if (statuses.some((s) => s !== 401)) throw new Error(`refreshed session ${statuses.join(',')}`);
      });

      await ctx.step('an admin force-logout of a second session answers 401 on the data routes at once', async () => {
        const second = await passwordGrantSession(ctx.env, email, PASSWORD);
        const secondPrincipal = keyPrincipal(person, second.accessToken, 'WSA4_SECOND');
        (await ctx.client.as(secondPrincipal).get(`/v1/workspaces/${w.id}/sessions`)).status(200);
        const sessionId = JSON.parse(Buffer.from(second.accessToken.split('.')[1]!, 'base64url').toString()).session_id as string;
        (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/iam/sessions/${sessionId}/revoke`, {})).status(200);
        (await ctx.client.as(secondPrincipal).get(`/v1/workspaces/${w.id}/sessions`)).status(401).body().has('$.code', 'session_token_revoked');
      });
    } finally {
      await db.end().catch(() => {});
    }
  },
);

// ── WS-AUTH-5 — agents: the person's role or grant ∩ ceiling, minus HUMAN_ONLY ─
flow(
  'WS-AUTH-5',
  {
    domain: 'workspaces',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'POST /v1/workspaces/:workspaceId/access/invite',
      'GET /v1/accounts/:workspaceId/members',
      'POST /v1/workspaces/:workspaceId/tokens',
      'DELETE /v1/workspaces/:workspaceId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ managedGit: true });
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
    const sandbox = new CliSandbox('wsa5');
    try {
      const cliEnv = (secret: string) => ({ KORTIX_TOKEN: secret, KORTIX_PROJECT_ID: project.id, KORTIX_API_URL: ctx.env.apiUrl });

      await ctx.step('the manifest declares `kortix` (no grant) and `steward` ("*")', async () => {
        await world.writeManifest('project:\n  name: example-org-wsa5\ndefault_agent: kortix\nagents:\n  kortix: {}\n  steward:\n    kortix_permissions: "*"\n');
      });

      await ctx.step('an inherited session (no agent grant) of the owner: `kortix access invite` → exit 0, the invite exists', async () => {
        const inherited = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER, skipGrantSync: true });
        const email = `${ctx.fixtures.name('wsa5-invitee')}@example.test`.toLowerCase();
        const r = await sandbox.run(['access', 'invite', email, '--role', 'member'], { env: cliEnv(inherited.secret) });
        if (r.exitCode !== 0) throw new Error(`kortix access invite: exit ${r.exitCode}: ${r.all.slice(0, 600)}`);
        const pending = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${project.id}/access/pending-invites`)).status(200).json<any>();
        if (!JSON.stringify(pending).includes(email)) throw new Error(`the invite is not pending: ${JSON.stringify(pending).slice(0, 300)}`);
      });

      let governedSecret = '';
      let governed!: Awaited<ReturnType<typeof world.mintAgentSession>>;
      await ctx.step("a governed '*' agent lists the workspace's members through the real CLI and over HTTP → 200", async () => {
        governed = await world.mintAgentSession({ agent: 'steward', launcher: ctx.P.OWNER });
        governedSecret = governed.secret;
        (await governed.client.get(`/v1/accounts/${team.id}/members`)).status(200);
        const r = await sandbox.run(['members', 'ls', '--account', team.id], { env: cliEnv(governedSecret) });
        if (r.exitCode !== 0) throw new Error(`kortix members ls: exit ${r.exitCode}: ${r.all.slice(0, 600)}`);
      });

      await ctx.step('the same agent minting a key or deleting the workspace → 403 agent_human_only_action', async () => {
        const mint = await governed.client.post(`/v1/workspaces/${project.id}/tokens`, { name: 'wsa5-agent-key' });
        mint.status(403).body().has('$.code', 'agent_human_only_action').has('$.workspace_action', 'workspace.token.create');
        (await governed.client.del(`/v1/workspaces/${project.id}`)).status(403).body().has('$.code', 'agent_human_only_action');
      });
    } finally {
      sandbox.dispose();
      await world.close();
    }
  },
);

// ── WS-AUTH-6 — act-as never writes IAM or deletes the workspace ────────────
flow(
  'WS-AUTH-6',
  {
    domain: 'workspaces',
    requires: ['admin'],
    routes: ['POST /v1/admin/api/impersonate', 'POST /v1/workspaces/:workspaceId/iam/assignments', 'DELETE /v1/workspaces/:workspaceId'],
  },
  async (ctx) => {
    const admin = ctx.client.withBearer(ctx.env.adminToken!, 'ADMIN_TOKEN');
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const grant = await admin.post('/v1/admin/api/impersonate', { account_id: team.id, reason: 'ke2e WS-AUTH-6' });
    grant.status(200);
    const acting = { headers: { 'x-kortix-impersonate': grant.json<{ grant_id: string }>().grant_id } };

    await ctx.step('under act-as, POST iam/assignments → 403 and DELETE workspace → 403; a read stays 200', async () => {
      const assign = await admin.post(
        `/v1/workspaces/${w.id}/iam/assignments`,
        { principal_type: 'user', principal_id: ctx.P.OWNER.userId, scope_type: 'account', role_key: 'admin' },
        acting,
      );
      assign.status(403);
      (await admin.del(`/v1/workspaces/${w.id}`, acting)).status(403);
      (await admin.get(`/v1/workspaces/${w.id}/iam/assignments`, acting)).status(200);
      (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}`)).status(200);
    });
  },
);

// ── WS-AUTH-7 — the /v1/workspaces IAM wire shows one scope ─────────────────
flow(
  'WS-AUTH-7',
  {
    domain: 'workspaces',
    requires: ['database'],
    routes: [
      'GET /v1/workspaces/:workspaceId/iam/roles',
      'GET /v1/accounts/:workspaceId/iam/roles',
      'GET /v1/workspaces/:workspaceId/iam/permissions',
      'GET /v1/workspaces/:workspaceId/iam/assignments',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();

    await ctx.step('roles: the ladder (owner, admin, manager, member) then custom roles; no agent-user; the legacy name keeps every row', async () => {
      const roles = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}/iam/roles`)).status(200).json<{ roles: any[] }>().roles;
      const system = roles.filter((r) => r.is_system).map((r) => r.key);
      if (JSON.stringify(system) !== JSON.stringify(['owner', 'admin', 'manager', 'member'])) throw new Error(`ladder ${JSON.stringify(system)}`);
      if (!roles.filter((r) => r.is_system).every((r) => r.ladder === true && r.scope === 'workspace')) throw new Error('ladder fields');
      // A custom role carries the same fields, off the ladder. (Creating one
      // needs the rbac entitlement; the row is written directly.)
      const db = await openDb(ctx);
      try {
        await db.query(`INSERT INTO kortix.roles (account_id, key, name, scope_type) VALUES ($1, 'wsa7_custom', 'WSA7 custom', 'project')`, [team.id]);
      } finally {
        await (db as unknown as { end(): Promise<void> }).end();
      }
      const withCustom = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}/iam/roles`)).status(200).json<{ roles: any[] }>().roles;
      const custom = withCustom.find((r) => r.key === 'wsa7_custom');
      if (custom?.ladder !== false || custom?.scope !== 'workspace') throw new Error(`custom role row ${JSON.stringify(custom)}`);
      const legacy = (await ctx.client.as(ctx.P.OWNER).get(`/v1/accounts/${team.id}/iam/roles`)).status(200).json<{ roles: any[] }>().roles;
      if (!legacy.some((r) => r.key === 'agent-user') || legacy.filter((r) => r.key === 'member').length !== 2) {
        throw new Error('the legacy role list changed');
      }
    });

    await ctx.step('permissions carry workspace_action and scope workspace', async () => {
      const rows = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}/iam/permissions`)).status(200).json<{ permissions: any[] }>().permissions;
      const read = rows.find((r) => r.action === 'project.read');
      if (read?.workspace_action !== 'workspace.read' || read?.scope !== 'workspace') throw new Error(`project.read row ${JSON.stringify(read)}`);
      if (!rows.every((r) => typeof r.workspace_action === 'string' && r.scope === 'workspace')) throw new Error('a row lacks the workspace fields');
    });

    await ctx.step("assignments carry scope workspace and the workspace id; the owner's account row names the workspace", async () => {
      const rows = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}/iam/assignments`)).status(200).json<{ assignments: any[] }>().assignments;
      const owner = rows.find((r) => r.principal_id === ctx.P.OWNER.userId && r.role_key === 'owner');
      if (owner?.scope !== 'workspace' || owner?.workspace_id !== w.id || owner?.scope_type !== 'account') {
        throw new Error(`owner row ${JSON.stringify(owner)}`);
      }
    });
  },
);

// ── WS-AUTH-8 — a session token with no service account is still an agent ───
// The My Kortix coordinator's session token names a session and an agent grant
// but no service account (mintSessionToken), so it classifies as a PAT that
// acts as its launcher. HUMAN_ONLY applies to it all the same.
flow(
  'WS-AUTH-8',
  {
    domain: 'workspaces',
    requires: ['database'],
    routes: [
      'POST /v1/workspaces/:workspaceId/tokens',
      'POST /v1/workspaces/:workspaceId/iam/service-accounts',
      'POST /v1/billing/auto-topup/configure',
      'DELETE /v1/workspaces/:workspaceId',
      'GET /v1/workspaces/:workspaceId/members',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const db = await openDb(ctx);
    const sessionId = crypto.randomUUID();
    try {
      let session!: ReturnType<typeof ctx.client.withBearer>;
      await ctx.step('the owner mints a workspace key; the row is bound to a session with the My Kortix grant and no service account', async () => {
        const minted = await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/tokens`, {
          name: 'wsa8-my-kortix',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
        minted.status(201);
        const { token_id, secret_key } = minted.json<{ token_id: string; secret_key: string }>();
        const grant = { agent: 'kortix', permissions: 'all', connectors: [], env: [] };
        // A live session and its sandbox, as a real My Kortix session has them:
        // a session token answers only while its sandbox is active.
        await db.query(
          `INSERT INTO kortix.project_sessions
             (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata)
           VALUES ($1, $2, $3, $1, 'kortix', 'running', $4, 'private', '{"workspace_mode":"branch"}'::jsonb)`,
          [sessionId, team.id, w.id, ctx.P.OWNER.userId],
        );
        await db.query(
          `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status)
           VALUES ($1::uuid, $1, $2, $3, 'active')`,
          [sessionId, team.id, w.id],
        );
        await db.query(
          `UPDATE kortix.account_tokens SET session_id = $2, agent_grant = $3::jsonb, service_account_id = NULL WHERE token_id = $1`,
          [token_id, sessionId, JSON.stringify(grant)],
        );
        session = ctx.client.withBearer(secret_key, 'MY_KORTIX_SESSION');
      });

      await ctx.step('the session keeps the person’s ordinary work: GET /workspaces/:w/members → 200', async () => {
        (await session.get(`/v1/workspaces/${w.id}/members`)).status(200);
      });

      await ctx.step('minting a service account, configuring auto-topup and deleting the workspace → 403 agent_human_only_action', async () => {
        (await session.post(`/v1/workspaces/${w.id}/iam/service-accounts`, { name: 'wsa8-sa' }))
          .status(403).body().has('$.code', 'agent_human_only_action');
        (await session.post('/v1/billing/auto-topup/configure', { account_id: team.id, enabled: true, threshold: 5, amount: 20 }))
          .status(403).body().has('$.code', 'agent_human_only_action');
        (await session.del(`/v1/workspaces/${w.id}`)).status(403).body().has('$.code', 'agent_human_only_action');
      });

      await ctx.step('the owner in the browser keeps the same power: POST /iam/service-accounts → 201; the workspace still answers 200', async () => {
        (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/iam/service-accounts`, { name: 'wsa8-owner-sa' })).status(201);
        (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}`)).status(200);
      });
    } finally {
      await db.query('DELETE FROM kortix.account_tokens WHERE session_id = $1', [sessionId]);
      await db.query('DELETE FROM kortix.session_sandboxes WHERE session_id = $1', [sessionId]);
      await db.query('DELETE FROM kortix.project_sessions WHERE session_id = $1', [sessionId]);
      await (db as unknown as { end(): Promise<void> }).end();
    }
  },
);

// ── WS-AUTH-9 — person-only routes refuse a machine credential first (403) ──
flow(
  'WS-AUTH-9',
  {
    domain: 'workspaces',
    routes: ['POST /v1/workspaces/:workspaceId/iam/service-accounts', 'GET /v1/oauth/grants', 'GET /v1/accounts/tokens'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    let sa!: ReturnType<typeof ctx.client.withBearer>;
    await ctx.step('the owner creates a service account → 201 with its secret', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/iam/service-accounts`, { name: 'wsa9-sa' });
      r.status(201);
      sa = ctx.client.withBearer(r.json<{ secret: string }>().secret, 'WSA9_SA');
    });
    await ctx.step('the service account on GET /oauth/grants and GET /accounts/tokens → 403, never 409 no_workspace', async () => {
      (await sa.get('/v1/oauth/grants')).status(403);
      (await sa.get('/v1/accounts/tokens')).status(403);
    });
    await ctx.step('the owner in the browser reads both → 200', async () => {
      (await ctx.client.as(ctx.P.OWNER).get('/v1/oauth/grants')).status(200);
      (await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/tokens', { query: { account_id: team.id } })).status(200);
    });
  },
);

// ── WS-AUTH-10 — a key's scope narrows it inside its creator's current role ──
flow(
  'WS-AUTH-10',
  {
    domain: 'workspaces',
    routes: [
      'POST /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/members',
      'POST /v1/workspaces/:workspaceId/members',
      'PATCH /v1/workspaces/:workspaceId/members/:userId',
      'GET /v1/workspaces/:workspaceId/iam/groups',
      'PATCH /v1/workspaces/:workspaceId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const mint = (who: Principal, body: Record<string, unknown>) => ctx.client.as(who).post(`/v1/workspaces/${w.id}/tokens`, body);
    const invite = (who: Principal) =>
      ctx.client.as(who).post(`/v1/workspaces/${w.id}/members`, { email: `${ctx.fixtures.name('wsa10-invitee')}@example.test`.toLowerCase() });

    await ctx.step('a read key: GET members and groups → 200; PATCH the workspace and POST a key → 403 key_scope_read_only', async () => {
      const minted = await mint(ctx.P.OWNER, { name: 'wsa10-read', scopes: 'read' });
      minted.status(201).body().has('$.scope', 'read').has('$.workspace_id', w.id);
      const read = keyPrincipal(ctx.P.OWNER, minted.json<{ secret_key: string }>().secret_key, 'WSA10_READ');
      (await ctx.client.as(read).get(`/v1/workspaces/${w.id}/members`)).status(200);
      (await ctx.client.as(read).get(`/v1/workspaces/${w.id}/iam/groups`)).status(200);
      (await ctx.client.as(read).patch(`/v1/workspaces/${w.id}`, { name: 'x' })).status(403).body().has('$.code', 'key_scope_read_only');
      (await ctx.client.as(read).post(`/v1/workspaces/${w.id}/tokens`, { name: 'child' })).status(403).body().has('$.code', 'key_scope_read_only');
      const listed = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}/tokens`, { query: { mine: 'true' } })).status(200).json<any[]>();
      const row = listed.find((t) => t.name === 'wsa10-read');
      if (row?.scope !== 'read') throw new Error(`list scope: ${JSON.stringify(row)}`);
    });

    await ctx.step('a custom key does exactly its list: member.read + member.invite reach members and invite; groups → 403 key_scope_insufficient', async () => {
      const minted = await mint(ctx.P.OWNER, { name: 'wsa10-custom', scopes: ['workspace.member.read', 'member.invite'] });
      minted.status(201).body().has('$.scope', 'custom');
      const perms = minted.json<{ workspace_permissions: string[] }>().workspace_permissions;
      if (JSON.stringify(perms) !== JSON.stringify(['workspace.member.invite', 'workspace.member.read'])) throw new Error(`permissions ${JSON.stringify(perms)}`);
      const custom = keyPrincipal(ctx.P.OWNER, minted.json<{ secret_key: string }>().secret_key, 'WSA10_CUSTOM');
      (await ctx.client.as(custom).get(`/v1/workspaces/${w.id}/members`)).status(200);
      (await invite(custom)).status(201);
      // The route asks `workspace.account.read` first: the refusal names it.
      (await ctx.client.as(custom).get(`/v1/workspaces/${w.id}/iam/groups`)).status(403).body()
        .has('$.code', 'key_scope_insufficient').has('$.workspace_action', 'workspace.account.read');
    });

    await ctx.step('an unknown permission → 400 invalid_scopes; a permission outside the role → 403 key_scope_exceeds_role', async () => {
      (await mint(ctx.P.OWNER, { name: 'wsa10-typo', scopes: ['workspace.nope'] })).status(400).body().has('$.code', 'invalid_scopes');
      const member = await ctx.fixtures.user({ label: 'WSA10-MEMBER' });
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, { email: member.email })).status(201);
      (await mint(member, { name: 'wsa10-over', scopes: ['workspace.member.remove'] })).status(403).body()
        .has('$.code', 'key_scope_exceeds_role');
    });

    await ctx.step("the creator's CURRENT role bounds the key: an admin's invite key stops inviting once the admin is a member again", async () => {
      const person = await ctx.fixtures.user({ label: 'WSA10-ADMIN' });
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, { email: person.email, role: 'admin' })).status(201);
      const minted = await mint(person, { name: 'wsa10-admin-invite', scopes: ['workspace.member.invite', 'workspace.member.read'] });
      minted.status(201);
      const key = keyPrincipal(person, minted.json<{ secret_key: string }>().secret_key, 'WSA10_ADMIN_KEY');
      (await invite(key)).status(201);
      (await ctx.client.as(ctx.P.OWNER).patch(`/v1/workspaces/${w.id}/members/${person.userId}`, { role: 'member' })).status(200);
      (await invite(key)).status(403);
      (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/members`)).status(200);
    });

    await ctx.step('a scoped key mints only inside its scope: omitted scopes inherit it; full → 403 key_scope_exceeds_parent', async () => {
      // A key that mints keys needs both credential leaves: token.create and credentials.issue.
      const minted = await mint(ctx.P.OWNER, {
        name: 'wsa10-minter',
        scopes: ['workspace.token.create', 'workspace.credentials.issue', 'workspace.member.read'],
      });
      minted.status(201);
      const minter = keyPrincipal(ctx.P.OWNER, minted.json<{ secret_key: string }>().secret_key, 'WSA10_MINTER');
      (await ctx.client.as(minter).post(`/v1/workspaces/${w.id}/tokens`, { name: 'wsa10-child-full', scopes: 'full' }))
        .status(403).body().has('$.code', 'key_scope_exceeds_parent');
      const child = await ctx.client.as(minter).post(`/v1/workspaces/${w.id}/tokens`, { name: 'wsa10-child' });
      child.status(201).body().has('$.scope', 'custom');
      const parentExpiry = minted.json<{ expires_at: string }>().expires_at;
      if (child.json<{ expires_at: string }>().expires_at !== parentExpiry) {
        throw new Error(`a default child expiry outlives its parent: ${child.json<any>().expires_at} vs ${parentExpiry}`);
      }
    });
  },
);

// ── WS-AUTH-11 — keys expire by default; the key policy may allow no expiry ──
flow(
  'WS-AUTH-11',
  {
    domain: 'workspaces',
    requires: ['database'],
    timeoutMs: 120_000,
    routes: [
      'POST /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/iam/pat-policy',
      'PATCH /v1/workspaces/:workspaceId/iam/pat-policy',
      'POST /v1/cli/device/start',
      'POST /v1/cli/device/decide',
      'POST /v1/cli/device/poll',
      'GET /v1/me/tokens',
      'DELETE /v1/me/tokens/:tokenId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const DAY = 86_400_000;
    const mint = (body: Record<string, unknown>) => ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/tokens`, body);
    const daysOut = (iso: string | null) => (iso ? (Date.parse(iso) - Date.now()) / DAY : Number.NaN);

    await ctx.step('the policy reads default 90 days, at most 365, no expiry not allowed', async () => {
      (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}/iam/pat-policy`)).status(200).body()
        .has('$.default_lifetime_days', 90).has('$.effective_max_lifetime_days', 365).has('$.allow_no_expiry', false);
    });

    await ctx.step('no expires_at → 90 days; 400 days → 400 expiry_too_far; null → 400 expiry_required', async () => {
      const r = await mint({ name: 'wsa11-default' });
      r.status(201);
      const days = daysOut(r.json<{ expires_at: string }>().expires_at);
      if (!(days > 89.9 && days <= 90)) throw new Error(`default expiry ${days} days`);
      (await mint({ name: 'wsa11-far', expires_at: new Date(Date.now() + 400 * DAY).toISOString() })).status(400).body().has('$.code', 'expiry_too_far');
      (await mint({ name: 'wsa11-never', expires_at: null })).status(400).body().has('$.code', 'expiry_required');
    });

    await ctx.step('allow_no_expiry → a null expiry mints a key that never expires and lists as such', async () => {
      (await ctx.client.as(ctx.P.OWNER).patch(`/v1/workspaces/${w.id}/iam/pat-policy`, { allow_no_expiry: true })).status(200).body()
        .has('$.allow_no_expiry', true);
      const r = await mint({ name: 'wsa11-forever', expires_at: null });
      r.status(201).body().has('$.expires_at', null);
      const key = keyPrincipal(ctx.P.OWNER, r.json<{ secret_key: string }>().secret_key, 'WSA11_FOREVER');
      (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/members`)).status(200);
    });

    await ctx.step('a key written before expiry existed (expires_at NULL, policy off) keeps working', async () => {
      (await ctx.client.as(ctx.P.OWNER).patch(`/v1/workspaces/${w.id}/iam/pat-policy`, { allow_no_expiry: false })).status(200);
      const r = await mint({ name: 'wsa11-legacy' });
      r.status(201);
      const db = await openDb(ctx);
      try {
        await db.query('UPDATE kortix.account_tokens SET expires_at = NULL WHERE token_id = $1', [r.json<{ token_id: string }>().token_id]);
      } finally {
        await db.end().catch(() => {});
      }
      const key = keyPrincipal(ctx.P.OWNER, r.json<{ secret_key: string }>().secret_key, 'WSA11_LEGACY');
      (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/members`)).status(200);
      const row = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${w.id}/tokens`, { query: { mine: 'true' } })).status(200).json<any[]>()
        .find((t) => t.name === 'wsa11-legacy');
      if (row?.expires_at !== null) throw new Error(`legacy row expires_at ${row?.expires_at}`);
    });

    await ctx.step("the key policy's idle revoke covers a workspace key: unused past idle_revoke_days → 401", async () => {
      const r = await mint({ name: 'wsa11-idle' });
      r.status(201);
      const key = keyPrincipal(ctx.P.OWNER, r.json<{ secret_key: string }>().secret_key, 'WSA11_IDLE');
      (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/members`)).status(200);
      (await ctx.client.as(ctx.P.OWNER).patch(`/v1/workspaces/${w.id}/iam/pat-policy`, { idle_revoke_days: 1 })).status(200);
      const db = await openDb(ctx);
      try {
        await db.query(`UPDATE kortix.account_tokens SET last_used_at = now() - interval '2 days' WHERE token_id = $1`, [r.json<{ token_id: string }>().token_id]);
      } finally {
        await db.end().catch(() => {});
      }
      (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/members`)).status(401);
      (await ctx.client.as(ctx.P.OWNER).patch(`/v1/workspaces/${w.id}/iam/pat-policy`, { idle_revoke_days: null })).status(200);
    });

    await ctx.step('the CLI device login is person-wide with a 90-day expiry that renews on use', async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      const start = (await anon.post('/v1/cli/device/start', {})).status(200).json<{ device_code: string; user_code: string }>();
      (await ctx.client.as(ctx.P.OWNER).post('/v1/cli/device/decide', { user_code: start.user_code, approve: true, account_id: team.id })).status(200);
      const token = (await anon.post('/v1/cli/device/poll', { device_code: start.device_code })).status(200).json<{ token: string }>().token;
      const cli = ctx.client.withBearer(token, 'WSA11_CLI');
      const tokenId = (await cli.get('/v1/me')).status(200).json<{ token_context: { token_id: string } }>().token_context.token_id;
      const row = (await ctx.client.as(ctx.P.OWNER).get('/v1/me/tokens')).status(200).json<any[]>().find((t) => t.token_id === tokenId);
      if (row?.expiry_renews !== true || row.workspace_id !== null) throw new Error(`device login row ${JSON.stringify(row)}`);
      const days = daysOut(row.expires_at);
      if (!(days > 89.9 && days <= 90)) throw new Error(`device login expiry ${days} days`);
      (await ctx.client.as(ctx.P.OWNER).del(`/v1/me/tokens/${tokenId}`)).status(200);
      (await cli.get('/v1/me')).status(401);
    });
  },
);

// ── WS-AUTH-12 — leaving a workspace takes the person's keys with them ──────
flow(
  'WS-AUTH-12',
  {
    domain: 'workspaces',
    routes: [
      'POST /v1/workspaces/:workspaceId/members',
      'POST /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/members',
      'DELETE /v1/workspaces/:workspaceId/members/:userId',
      'POST /v1/workspaces/:workspaceId/leave',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const memberWithKey = async (label: string) => {
      const person = await ctx.fixtures.user({ label });
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${w.id}/members`, { email: person.email })).status(201);
      const key = keyPrincipal(person, await mintWorkspaceKey(ctx, person, w.id, `${label.toLowerCase()}-key`), `${label}_KEY`);
      (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/members`)).status(200);
      return { person, key };
    };

    await ctx.step('removed by an owner: the key that worked → 401', async () => {
      const { person, key } = await memberWithKey('WSA12-REMOVED');
      (await ctx.client.as(ctx.P.OWNER).del(`/v1/workspaces/${w.id}/members/${person.userId}`)).status(200);
      (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/members`)).status(401);
    });

    await ctx.step('the member leaves: the key that worked → 401', async () => {
      const { person, key } = await memberWithKey('WSA12-LEFT');
      (await ctx.client.as(person).post(`/v1/workspaces/${w.id}/leave`, {})).status(200);
      (await ctx.client.as(key).get(`/v1/workspaces/${w.id}/members`)).status(401);
    });
  },
);

// ── WS-AUTH-13 — an OAuth grant names one workspace and reaches it only ─────
flow(
  'WS-AUTH-13',
  {
    domain: 'workspaces',
    timeoutMs: 120_000,
    routes: [
      'POST /v1/accounts/:workspaceId/iam/oauth-clients',
      'GET /v1/oauth/authorize',
      'GET /v1/oauth/authorize/consent/:requestId',
      'POST /v1/oauth/authorize/consent',
      'POST /v1/oauth/token',
      'GET /v1/workspaces/:workspaceId/members',
      'GET /v1/workspaces',
      'POST /v1/billing/plan/preview',
      'GET /v1/projects',
      'GET /v1/drives/usage',
    ],
  },
  async (ctx) => {
    const a = await (await ctx.fixtures.team()).project();
    const bTeam = await ctx.fixtures.team();
    const b = await bTeam.project();
    const redirectUri = 'https://app.example.test/oauth/callback';
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url');
    const challenge = Buffer.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))).toString('base64url');
    const form = (fields: Record<string, string>) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return fd;
    };
    const registered = await ctx.client.as(ctx.P.OWNER).post(`/v1/accounts/${bTeam.id}/iam/oauth-clients`, {
      name: ctx.fixtures.name('wsa13-app'),
      redirect_uris: [redirectUri],
      scopes: ['profile', 'kortix'],
    });
    registered.status(201);
    const clientId = registered.json<{ client_id: string }>().client_id;
    const secret = registered.json<{ client_secret: string }>().client_secret;

    const authorize = async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/oauth/authorize', {
        query: { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'profile kortix', code_challenge: challenge, code_challenge_method: 'S256' },
      });
      r.status(302);
      return new URL(r.header('location')!).searchParams.get('request_id')!;
    };
    const redeem = async (consent: Record<string, unknown>) => {
      const ok = await ctx.client.as(ctx.P.OWNER).post('/v1/oauth/authorize/consent', consent);
      ok.status(200);
      const code = new URL(ok.json<{ redirect_uri: string }>().redirect_uri).searchParams.get('code')!;
      const t = await ctx.client.as(ctx.P.ANON).post(
        '/v1/oauth/token',
        form({ grant_type: 'authorization_code', client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri, code_verifier: verifier }),
      );
      t.status(200);
      return t.json<{ access_token: string; refresh_token: string }>();
    };
    const members = (token: string, workspaceId: string) =>
      ctx.client.as(ctx.P.ANON).get(`/v1/workspaces/${workspaceId}/members`, { headers: { Authorization: `Bearer ${token}` } });

    await ctx.step('the consent request asks which workspace; an unknown workspace → 403 and the request stays open', async () => {
      const rid = await authorize();
      (await ctx.client.as(ctx.P.OWNER).get(`/v1/oauth/authorize/consent/${rid}`)).status(200).body().has('$.asks_workspace', true);
      // An id no workspace has answers as a workspace the person cannot open.
      (await ctx.client.as(ctx.P.OWNER).post('/v1/oauth/authorize/consent', { request_id: rid, approved: true, workspace_id: crypto.randomUUID() }))
        .status(403).body().has('$.code', 'workspace_not_found');
      // The refusal did not consume the request: the same request still approves.
      await redeem({ request_id: rid, approved: true, workspace_id: a.id });
    });

    await ctx.step('a token bound to A: A → 200, B → 403 credential_fence_refused, GET /workspaces lists A only; a refresh stays bound', async () => {
      const pair = await redeem({ request_id: await authorize(), approved: true, workspace_id: a.id });
      (await members(pair.access_token, a.id)).status(200);
      expectFence(await members(pair.access_token, b.id), 'cross-workspace', 'B with a token bound to A');
      const listed = (await ctx.client.as(ctx.P.ANON).get('/v1/workspaces', { headers: { Authorization: `Bearer ${pair.access_token}` } }))
        .status(200).json<any[]>();
      if (listed.length !== 1 || listed[0]?.workspace_id !== a.id) throw new Error(`bound token listed ${JSON.stringify(listed.map((r) => r.workspace_id))}`);
      const refreshed = await ctx.client.as(ctx.P.ANON).post('/v1/oauth/token', form({ grant_type: 'refresh_token', client_id: clientId, client_secret: secret, refresh_token: pair.refresh_token }));
      refreshed.status(200);
      const next = refreshed.json<{ access_token: string }>().access_token;
      (await members(next, a.id)).status(200);
      expectFence(await members(next, b.id), 'cross-workspace', 'B with a refreshed token bound to A');
    });

    await ctx.step("a token bound to A names B by a param: a text/plain billing body → 403, the project list and the Drive usage of B's account show nothing of B", async () => {
      const pair = await redeem({ request_id: await authorize(), approved: true, workspace_id: a.id });
      const bearer = { Authorization: `Bearer ${pair.access_token}` };
      // Handlers parse the body whatever the Content-Type says, so the fence must too.
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
        const res = await fetch(`${ctx.env.apiUrl}/billing/plan/preview`, {
          method: 'POST',
          headers: { ...bearer, 'content-type': contentType },
          body: JSON.stringify({ account_id: bTeam.id, monthly_usd: 50 }),
        });
        const text = await res.text();
        if (res.status !== 403) throw new Error(`${contentType} body naming B: expected 403, got ${res.status} ${text.slice(0, 200)}`);
        if (JSON.parse(text).code !== FENCE) throw new Error(`${contentType} body naming B: expected ${FENCE}, got ${text.slice(0, 200)}`);
      }
      const listed = await ctx.client.as(ctx.P.ANON).get('/v1/projects', { query: { account_id: bTeam.id }, headers: bearer });
      if (listed.statusCode === 200 && listed.text().includes(b.id)) throw new Error(`a token bound to A listed B's project: ${listed.text().slice(0, 200)}`);
      if (listed.statusCode !== 200 && listed.statusCode !== 403) throw new Error(`GET /projects?account_id=B → ${listed.statusCode}`);
      const usage = await ctx.client.as(ctx.P.ANON).get('/v1/drives/usage', { query: { account_id: bTeam.id }, headers: bearer });
      if (usage.statusCode !== 403) throw new Error(`GET /drives/usage?account_id=B: expected 403, got ${usage.statusCode} ${usage.text().slice(0, 200)}`);
      // The same token still reads its own account's usage.
      (await ctx.client.as(ctx.P.ANON).get('/v1/drives/usage', { headers: bearer })).status([200, 404]);
    });

    await ctx.step('a consent that names no workspace (an older consent screen) stays unbound: A and B → 200', async () => {
      const pair = await redeem({ request_id: await authorize(), approved: true });
      (await members(pair.access_token, a.id)).status(200);
      (await members(pair.access_token, b.id)).status(200);
    });
  },
);

// ── WS-AUTH-14 — closing one workspace never ends the person's own keys ──────
flow(
  'WS-AUTH-14',
  {
    domain: 'workspaces',
    routes: [
      'POST /v1/accounts/tokens',
      'POST /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/members',
      'DELETE /v1/workspaces/:workspaceId',
      'POST /v1/workspaces/:workspaceId/restore',
    ],
  },
  async (ctx) => {
    const aTeam = await ctx.fixtures.team();
    const a = await aTeam.project();
    const b = await (await ctx.fixtures.team()).project();
    const owner = ctx.client.as(ctx.P.OWNER);

    // A personal key anchored at A's account (the case the close used to revoke).
    const minted = await owner.post('/v1/accounts/tokens', {
      name: 'wsa14-personal',
      account_id: aTeam.id,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    minted.status(201).body().has('$.project_id', null);
    const personal = keyPrincipal(ctx.P.OWNER, minted.json<{ secret_key: string }>().secret_key, 'WSA14_PERSONAL');
    const keyOfA = keyPrincipal(ctx.P.OWNER, await mintWorkspaceKey(ctx, ctx.P.OWNER, a.id, 'wsa14-a'), 'WSA14_A');

    await ctx.step('the owner deletes A → 200; the personal key anchored at A still reaches B → 200; the key bound to A → 401', async () => {
      (await owner.del('/v1/workspaces/:workspaceId', { params: { workspaceId: a.id } })).status(200).body().has('$.deleted', true);
      (await ctx.client.as(personal).get(`/v1/workspaces/${b.id}/members`)).status(200);
      (await ctx.client.as(keyOfA).get(`/v1/workspaces/${b.id}/members`)).status(401);
    });

    await ctx.step('the owner restores A → 200; the personal key reaches A and B again', async () => {
      (await owner.post('/v1/workspaces/:workspaceId/restore', {}, { params: { workspaceId: a.id } })).status(200).body().has('$.state', 'active');
      (await ctx.client.as(personal).get(`/v1/workspaces/${a.id}/members`)).status(200);
      (await ctx.client.as(personal).get(`/v1/workspaces/${b.id}/members`)).status(200);
    });
  },
);

// ── WS-AUTH-15 — one API keys concept: a key acts as me, an agent, or a bot ──
flow(
  'WS-AUTH-15',
  {
    domain: 'workspaces',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'GET /v1/workspaces/:workspaceId/keys',
      'POST /v1/workspaces/:workspaceId/keys',
      'DELETE /v1/workspaces/:workspaceId/keys/:keyId',
      'GET /v1/accounts/:workspaceId/keys',
      'POST /v1/accounts/:workspaceId/keys',
      'DELETE /v1/accounts/:workspaceId/keys/:keyId',
      'POST /v1/workspaces/:workspaceId/members',
      'DELETE /v1/workspaces/:workspaceId/members/:userId',
      'POST /v1/workspaces/:workspaceId/iam/service-accounts',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project({ managedGit: true });
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: w.id });
    const owner = ctx.client.as(ctx.P.OWNER);
    const keys = `/v1/workspaces/${w.id}/keys`;
    const expiresAt = () => new Date(Date.now() + 3_600_000).toISOString();
    type Key = { key_id: string; secret_key: string; acts_as: { type: string; name: string | null; service_account_id: string | null }; scope: string; created_by: string | null };
    const mint = async (who: Principal, body: Record<string, unknown>, status = 201) => {
      const r = await ctx.client.as(who).post(keys, { expires_at: expiresAt(), ...body });
      r.status(status);
      return r.json<Key & { code?: string; permissions?: string[] }>();
    };
    const as = (key: Key, label: string) => keyPrincipal(ctx.P.OWNER, key.secret_key, label);
    /** The audit rows a key's requests wrote (the request rows of its own credential). */
    const auditOf = (keyId: string) =>
      waitFor(
        async () =>
          (
            await world.db.query(
              `SELECT actor_type, actor_user_id::text AS actor_user_id, agent_id, agent_name, credential_id
                 FROM kortix.audit_events WHERE account_id = $1::uuid AND credential_id = $2 ORDER BY occurred_at`,
              [team.id, keyId],
            )
          ).rows as Array<{ actor_type: string; actor_user_id: string | null; agent_id: string | null; agent_name: string | null }>,
        { until: (rows) => rows.length > 0, timeoutMs: 20_000, intervalMs: 250, description: `audit rows of key ${keyId}` },
      );
    try {
      await ctx.step('the manifest declares `kortix` (no permissions), `steward` ("*") and `auditor` (session read only)', async () => {
        await world.writeManifest(
          'project:\n  name: example-org-wsa15\ndefault_agent: kortix\nagents:\n  kortix: {}\n  steward:\n    kortix_permissions: "*"\n  auditor:\n    kortix_permissions: [project.session.read]\n',
        );
      });

      await ctx.step('GET /keys as the owner → can_manage_principals, the three agents a key can act as, no bot yet', async () => {
        const r = (await owner.get(keys)).status(200);
        r.body().has('$.can_manage_principals', true);
        const agents = r.json<{ agents: Array<{ name: string }> }>().agents.map((a) => a.name);
        if (agents.join(',') !== 'auditor,kortix,steward') throw new Error(`agents: ${agents.join(',')}`);
      });

      let meKey!: Key;
      await ctx.step('acts_as me (read only) → 201 acts_as me; it reads members (200), a write → 403 key_scope_read_only; audit names the owner', async () => {
        meKey = await mint(ctx.P.OWNER, { name: 'wsa15-me', acts_as: 'me', scopes: 'read' });
        if (meKey.acts_as.type !== 'me' || meKey.scope !== 'read' || meKey.created_by !== ctx.P.OWNER.userId) throw new Error(JSON.stringify(meKey));
        (await ctx.client.as(as(meKey, 'ME_KEY')).get(`/v1/workspaces/${w.id}/members`)).status(200);
        (await ctx.client.as(as(meKey, 'ME_KEY')).patch(`/v1/workspaces/${w.id}`, { name: 'nope' })).status(403).body().has('$.code', 'key_scope_read_only');
        const rows = await auditOf(meKey.key_id);
        if (!rows.every((row) => row.actor_type === 'human' && row.actor_user_id === ctx.P.OWNER.userId)) throw new Error(`me audit: ${JSON.stringify(rows)}`);
      });

      let stewardKey!: Key;
      await ctx.step("acts_as agent steward → 201; it authorizes as the agent: sessions and secrets 200, minting a key → 403 agent_human_only_action; audit names the agent, no person", async () => {
        stewardKey = await mint(ctx.P.OWNER, { name: 'wsa15-steward', acts_as: 'agent', agent: 'steward' });
        if (stewardKey.acts_as.type !== 'agent' || stewardKey.acts_as.name !== 'steward' || !stewardKey.acts_as.service_account_id) throw new Error(JSON.stringify(stewardKey.acts_as));
        const agent = ctx.client.as(as(stewardKey, 'STEWARD_KEY'));
        (await agent.get(`/v1/workspaces/${w.id}/sessions`)).status(200);
        (await agent.get(`/v1/workspaces/${w.id}/secrets`)).status(200);
        (await agent.post(`/v1/workspaces/${w.id}/iam/service-accounts`, { name: 'from-agent-key' })).status(403).body().has('$.code', 'agent_human_only_action');
        (await agent.post(keys, { name: 'from-agent-key', acts_as: 'me' })).status(403);
        const rows = await auditOf(stewardKey.key_id);
        const read = rows.find((row) => row.actor_type === 'agent');
        if (!read || read.agent_name !== 'steward' || read.agent_id !== stewardKey.acts_as.service_account_id || read.actor_user_id !== null) {
          throw new Error(`agent audit: ${JSON.stringify(rows)}`);
        }
      });

      await ctx.step("acts_as agent auditor → its grant bounds the key: sessions 200, secrets 403; a custom scope outside the grant → 403 key_scope_exceeds_principal and no key is left", async () => {
        const auditor = await mint(ctx.P.OWNER, { name: 'wsa15-auditor', acts_as: 'agent', agent: 'auditor' });
        const agent = ctx.client.as(as(auditor, 'AUDITOR_KEY'));
        (await agent.get(`/v1/workspaces/${w.id}/sessions`)).status(200);
        (await agent.get(`/v1/workspaces/${w.id}/secrets`)).status(403);
        const refused = await mint(ctx.P.OWNER, { name: 'wsa15-too-wide', acts_as: 'agent', agent: 'auditor', scopes: ['workspace.secret.read'] }, 403);
        if (refused.code !== 'key_scope_exceeds_principal' || refused.permissions?.join() !== 'project.secret.read') throw new Error(JSON.stringify(refused));
        const listed = (await owner.get(keys)).status(200).json<{ keys: Array<{ name: string }> }>().keys.map((k) => k.name);
        if (listed.includes('wsa15-too-wide')) throw new Error('the refused key is listed');
        await mint(ctx.P.OWNER, { name: 'wsa15-nobody', acts_as: 'agent', agent: 'mykortix' }, 400);
        await mint(ctx.P.OWNER, { name: 'wsa15-unknown', acts_as: 'agent', agent: 'nope' }, 404);
      });

      let botKey!: Key;
      await ctx.step('acts_as bot (a new name) → 201 creates the bot with the Member role; the key reads sessions (200), mints nothing (403); audit names the bot as a service account', async () => {
        botKey = await mint(ctx.P.OWNER, { name: 'wsa15-ci', acts_as: 'bot', bot: 'wsa15-ci-bot' });
        if (botKey.acts_as.type !== 'bot' || botKey.acts_as.name !== 'wsa15-ci-bot') throw new Error(JSON.stringify(botKey.acts_as));
        const bot = ctx.client.as(as(botKey, 'BOT_KEY'));
        (await bot.get(`/v1/workspaces/${w.id}/sessions`)).status(200);
        (await bot.post(`/v1/workspaces/${w.id}/iam/service-accounts`, { name: 'from-bot-key' })).status(403).body().has('$.code', 'agent_human_only_action');
        const rows = await auditOf(botKey.key_id);
        if (!rows.every((row) => row.actor_type === 'service_account' && row.actor_user_id === botKey.acts_as.service_account_id)) {
          throw new Error(`bot audit: ${JSON.stringify(rows)}`);
        }
        const listed = (await owner.get(keys)).status(200).json<{ bots: Array<{ name: string; has_role: boolean }> }>().bots;
        if (!listed.some((b) => b.name === 'wsa15-ci-bot' && b.has_role)) throw new Error(`bots: ${JSON.stringify(listed)}`);
        // A second key of the same bot reuses it.
        const again = await mint(ctx.P.OWNER, { name: 'wsa15-ci-2', acts_as: 'bot', bot: 'wsa15-ci-bot', scopes: 'read' });
        if (again.acts_as.service_account_id !== botKey.acts_as.service_account_id) throw new Error('a second bot was created');
      });

      await ctx.step('an older bot (POST /iam/service-accounts) lists its own bearer as a bot key; DELETE /keys/:id disables it → its bearer answers 401', async () => {
        const sa = (await owner.post(`/v1/workspaces/${w.id}/iam/service-accounts`, { name: 'wsa15-legacy-bot' })).status(201).json<{ service_account_id: string; secret: string }>();
        const row = (await owner.get(keys)).status(200).json<{ keys: Array<{ key_id: string; credential: string; acts_as: { type: string } }> }>().keys
          .find((k) => k.key_id === sa.service_account_id);
        if (!row || row.credential !== 'service_account_bearer' || row.acts_as.type !== 'bot') throw new Error(`legacy bot row: ${JSON.stringify(row)}`);
        (await owner.del(`${keys}/${sa.service_account_id}`)).status(200);
        (await ctx.client.withBearer(sa.secret, 'LEGACY_BOT').get(`/v1/workspaces/${w.id}/sessions`)).status(401);
      });

      await ctx.step('a plain member: GET /keys lists only their own keys, no agents or bots; acts_as agent → 403; another key → 403 on DELETE', async () => {
        const member = await team.addMember('member');
        const mine = await mint(member, { name: 'wsa15-member', acts_as: 'me' });
        const r = (await ctx.client.as(member).get(keys)).status(200);
        r.body().has('$.can_manage_principals', false).has('$.agents.length', 0).has('$.bots.length', 0);
        const names = r.json<{ keys: Array<{ key_id: string }> }>().keys.map((k) => k.key_id);
        if (names.join() !== mine.key_id) throw new Error(`member sees ${names.join()}`);
        await mint(member, { name: 'wsa15-member-agent', acts_as: 'agent', agent: 'steward' }, 403);
        (await ctx.client.as(member).del(`${keys}/${stewardKey.key_id}`)).status(403);
        (await ctx.client.as(member).del(`${keys}/${mine.key_id}`)).status(200);
      });

      await ctx.step("an admin's agent key survives the admin's removal; the admin's own key does not", async () => {
        const admin = await team.addMember('admin');
        const agentKey = await mint(admin, { name: 'wsa15-admin-agent', acts_as: 'agent', agent: 'steward' });
        const ownKey = await mint(admin, { name: 'wsa15-admin-me', acts_as: 'me' });
        if (agentKey.created_by !== admin.userId) throw new Error(`created_by ${agentKey.created_by}`);
        (await owner.del(`/v1/workspaces/${w.id}/members/${admin.userId}`)).status(200);
        (await ctx.client.as(as(agentKey, 'ADMIN_AGENT_KEY')).get(`/v1/workspaces/${w.id}/sessions`)).status(200);
        (await ctx.client.as(as(ownKey, 'ADMIN_OWN_KEY')).get(`/v1/workspaces/${w.id}/members`)).status(401);
      });

      await ctx.step('revoke: DELETE /keys/:id on the agent and bot keys → 200, each → 401; the legacy alias lists the same keys', async () => {
        (await owner.del(`${keys}/${stewardKey.key_id}`)).status(200);
        (await owner.del(`/v1/accounts/${w.id}/keys/${botKey.key_id}`)).status(200);
        (await ctx.client.as(as(stewardKey, 'STEWARD_KEY')).get(`/v1/workspaces/${w.id}/sessions`)).status(401);
        (await ctx.client.as(as(botKey, 'BOT_KEY')).get(`/v1/workspaces/${w.id}/sessions`)).status(401);
        const viaAlias = (await owner.get(`/v1/accounts/${w.id}/keys`)).status(200).json<{ keys: Array<{ key_id: string; status: string }> }>().keys;
        if (viaAlias.find((k) => k.key_id === stewardKey.key_id)?.status !== 'revoked') throw new Error('the alias does not list the revoked agent key');
        await mint(ctx.P.OWNER, { name: 'wsa15-alias', acts_as: 'me' }).then(async (k) => {
          (await owner.post(`/v1/accounts/${w.id}/keys`, { name: 'wsa15-alias-2', expires_at: expiresAt() })).status(201);
          (await owner.del(`${keys}/${k.key_id}`)).status(200);
        });
      });
    } finally {
      await world.close();
    }
  },
);
