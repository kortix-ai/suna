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
