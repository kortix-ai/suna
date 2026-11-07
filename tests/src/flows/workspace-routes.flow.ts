/**
 * Workspace routes (spec `WS-ROUTE-*`, design.md §3.2 C5).
 *
 * `/v1/workspaces` is the canonical workspace API. Its sub-routes are the old
 * routes under a second name: each flow calls BOTH names and asserts the same
 * status and body, so an alias can never drift from its route. The workspace
 * resource itself (list, create, record, update) is its own route, and the
 * legacy names keep their old meaning. Canonical paths take workspace ids
 * only (404 `workspace_not_found` otherwise); legacy paths take either id.
 *
 * Accounts, connectors, secrets and retired flows keep the legacy names.
 */
import { flow } from '../core/flow';
import type { FlowContext, Principal } from '../core/types';
import { createDatabaseSession, fundDatabaseAccount } from '../fixtures/database-project';

/** Volatile fields two otherwise equal answers may differ in. */
const VOLATILE = /"(request_id|timestamp|server_time|generated_at|last_seen_at|last_opened_at|updated_at|expires_at)":\s*("[^"]*"|\d+|null)/g;
/** A fence denial names the requested path (`… path=/v1/workspaces/…]`): the one intended difference. */
const DENIED_PATH = /path=[^\]\s"]+/g;
const stable = (text: string) => text.replace(VOLATILE, '"$1":"*"').replace(DENIED_PATH, 'path=*');

async function sameAnswer(ctx: FlowContext, who: Principal, legacy: string, canonical: string): Promise<number> {
  const [a, b] = await Promise.all([ctx.client.as(who).get(legacy), ctx.client.as(who).get(canonical)]);
  if (a.statusCode !== b.statusCode) {
    throw new Error(`${legacy} → ${a.statusCode}, ${canonical} → ${b.statusCode}`);
  }
  if (stable(a.text()) !== stable(b.text())) {
    throw new Error(`${legacy} and ${canonical} answer different bodies:\n${a.text().slice(0, 300)}\n${b.text().slice(0, 300)}`);
  }
  return a.statusCode;
}

/** The one answer for every id a canonical path does not serve. */
async function notFound(ctx: FlowContext, who: Principal, path: string): Promise<void> {
  const r = await ctx.client.as(who).get(path);
  r.status(404).body().has('$.code', 'workspace_not_found');
}

const randomId = () => crypto.randomUUID();

flow(
  'WS-ROUTE-1',
  {
    domain: 'workspaces',
    routes: [
      'GET /v1/workspaces',
      'GET /v1/projects',
      'GET /v1/workspaces/:workspaceId',
      'GET /v1/projects/:workspaceId',
      'GET /v1/workspaces/:workspaceId/sessions',
      'GET /v1/projects/:workspaceId/sessions',
      'GET /v1/workspaces/:workspaceId/secrets',
      'GET /v1/projects/:workspaceId/secrets',
      'GET /v1/workspaces/:workspaceId/access',
      'GET /v1/projects/:workspaceId/access',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();

    await ctx.step('GET /v1/workspaces lists the workspace with workspace_id, role and state; GET /v1/projects?account_id= keeps its one-account list', async () => {
      const list = (await ctx.client.as(ctx.P.OWNER).get('/v1/workspaces')).status(200).json<any[]>();
      const row = list.find((w) => w.workspace_id === p.id);
      if (!row) throw new Error('the workspace is missing from GET /v1/workspaces');
      if (row.project_id !== p.id || row.account_id !== team.id || row.role !== 'owner' || row.state !== 'active') {
        throw new Error(`list row ${JSON.stringify({ ...row, metadata: undefined, experimental: undefined }).slice(0, 300)}`);
      }
      const legacy = (await ctx.client.as(ctx.P.OWNER).get('/v1/projects', { query: { account_id: team.id } })).status(200).json<any[]>();
      if (legacy.length !== 1 || legacy[0].project_id !== p.id || legacy[0].workspace_id !== p.id) {
        throw new Error(`GET /v1/projects?account_id= is no longer the one-account list: ${legacy.map((r) => r.project_id)}`);
      }
      // The legacy list keeps either id in account_id.
      const byWorkspaceId = await ctx.client.as(ctx.P.OWNER).get('/v1/projects', { query: { account_id: p.id } });
      if (!byWorkspaceId.status(200).json<any[]>().some((w) => w.project_id === p.id)) throw new Error('account_id=<workspace id> missed the workspace');
    });

    await ctx.step('project-family reads answer identically under /v1/projects and /v1/workspaces', async () => {
      for (const tail of ['sessions', 'secrets', 'access']) {
        const status = await sameAnswer(ctx, ctx.P.OWNER, `/v1/projects/${p.id}/${tail}`, `/v1/workspaces/${p.id}/${tail}`);
        if (status !== 200) throw new Error(`${tail} → ${status}`);
      }
    });

    await ctx.step('GET /v1/workspaces/:id is the record with a top-level role and state plus the settings block; GET /v1/projects/:id is the bare record', async () => {
      const ws = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${p.id}`)).status(200).json<any>();
      if (ws.project_id !== p.id || ws.workspace_id !== p.id) throw new Error(`ids ${ws.project_id} ${ws.workspace_id}`);
      if (ws.role !== 'owner' || ws.state !== 'active' || ws.split_pending !== false) {
        throw new Error(`role/state ${ws.role} ${ws.state} ${ws.split_pending}`);
      }
      if (ws.workspace?.workspace_id !== p.id || ws.workspace?.account_id !== team.id) {
        throw new Error(`settings block ${JSON.stringify(ws.workspace)}`);
      }
      if (typeof ws.workspace.mfa_required !== 'boolean' || typeof ws.workspace.member_count !== 'number') {
        throw new Error(`settings fields ${JSON.stringify(ws.workspace)}`);
      }
      const legacy = (await ctx.client.as(ctx.P.OWNER).get(`/v1/projects/${p.id}`)).status(200).json<any>();
      if ('workspace' in legacy || 'role' in legacy || legacy.workspace_id !== p.id) throw new Error('legacy record shape changed');
    });

    await ctx.step('a non-member: the legacy name keeps its refusal; the canonical name answers 404 workspace_not_found; ANON → 401', async () => {
      for (const tail of ['', '/sessions']) {
        const legacy = await ctx.client.as(ctx.P.NONMEMBER).get(`/v1/projects/${p.id}${tail}`);
        if (legacy.statusCode !== 403 && legacy.statusCode !== 404) throw new Error(`legacy ${tail || 'record'} → ${legacy.statusCode}`);
        await notFound(ctx, ctx.P.NONMEMBER, `/v1/workspaces/${p.id}${tail}`);
      }
      (await ctx.client.get(`/v1/workspaces/${p.id}/sessions`)).status(401);
    });
  },
);

flow(
  'WS-ROUTE-2',
  {
    domain: 'workspaces',
    routes: [
      'GET /v1/workspaces/:workspaceId/members',
      'GET /v1/accounts/:workspaceId/members',
      'GET /v1/workspaces/:workspaceId/iam/roles',
      'GET /v1/accounts/:workspaceId/iam/roles',
      'GET /v1/workspaces/:workspaceId/invites',
      'GET /v1/accounts/:workspaceId/invites',
      'GET /v1/workspaces/:workspaceId/branding',
      'GET /v1/accounts/:workspaceId/branding',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();

    await ctx.step('an account family answers the same by account key (legacy) and by workspace id (canonical)', async () => {
      // `iam/roles` differs on purpose: the canonical name lists the one role ladder (finding 13).
      for (const tail of ['members', 'invites', 'branding']) {
        const legacy = `/v1/accounts/${team.id}/${tail}`;
        const status = await sameAnswer(ctx, ctx.P.OWNER, legacy, `/v1/workspaces/${p.id}/${tail}`);
        if (status !== 200) throw new Error(`${tail} → ${status}`);
        // The legacy name takes either id.
        await sameAnswer(ctx, ctx.P.OWNER, legacy, `/v1/accounts/${p.id}/${tail}`);
        // The canonical name takes the workspace id only.
        await notFound(ctx, ctx.P.OWNER, `/v1/workspaces/${team.id}/${tail}`);
      }
    });

    await ctx.step('a non-member: the legacy family keeps its 403; the canonical family answers 404 workspace_not_found', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).get(`/v1/accounts/${team.id}/members`)).status(403);
      await notFound(ctx, ctx.P.NONMEMBER, `/v1/workspaces/${p.id}/members`);
    });

    await ctx.step('an account with no project that does not pay: its legacy routes answer; it is no workspace on the canonical names', async () => {
      const dormant = await ctx.fixtures.team();
      (await ctx.client.as(ctx.P.OWNER).get(`/v1/accounts/${dormant.id}/members`)).status(200);
      await notFound(ctx, ctx.P.OWNER, `/v1/workspaces/${dormant.id}/members`);
      await notFound(ctx, ctx.P.OWNER, `/v1/workspaces/${dormant.id}`);
    });
  },
);

flow(
  'WS-ROUTE-3',
  {
    domain: 'workspaces',
    routes: [
      'GET /v1/me',
      'GET /v1/accounts/me',
      'GET /v1/invites',
      'GET /v1/account-invites',
      'POST /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces/:workspaceId/tokens',
      'DELETE /v1/workspaces/:workspaceId/tokens/:tokenId',
      'POST /v1/accounts/:workspaceId/tokens',
      'GET /v1/accounts/:workspaceId/tokens',
      'DELETE /v1/accounts/:workspaceId/tokens/:tokenId',
      'GET /v1/accounts/tokens',
      'POST /v1/accounts/tokens',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();

    await ctx.step('/v1/me is /v1/accounts/me; /v1/invites is /v1/account-invites', async () => {
      // A member of this team only: OWNER's workspace list grows while other
      // flows create teams, so two reads of it can differ by a workspace.
      const member = await team.addMember('member');
      if ((await sameAnswer(ctx, member, '/v1/accounts/me', '/v1/me')) !== 200) throw new Error('/v1/me');
      if ((await sameAnswer(ctx, member, '/v1/account-invites', '/v1/invites')) !== 200) throw new Error('/v1/invites');
      const me = (await ctx.client.as(member).get('/v1/me')).json<any>();
      const membership = (me.accounts as any[]).find((a) => a.account_id === team.id);
      if (membership?.workspace_id !== p.id) throw new Error(`me.accounts workspace_id ${membership?.workspace_id}`);
    });

    let tokenId = '';
    let secret = '';
    await ctx.step('a workspace key minted under /v1/workspaces/:id/tokens carries workspace_id and lists under every token name', async () => {
      const minted = await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${p.id}/tokens`, {
        name: 'ws-route-3',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      minted.status(201).body().has('$.project_id', p.id).has('$.workspace_id', p.id).exists('$.secret_key');
      tokenId = minted.json<any>().token_id;
      secret = minted.json<any>().secret_key;
      for (const list of [
        `/v1/workspaces/${p.id}/tokens`,
        `/v1/accounts/${team.id}/tokens`,
        `/v1/accounts/tokens?account_id=${team.id}`,
        `/v1/accounts/tokens?account_id=${p.id}`,
      ]) {
        const rows = (await ctx.client.as(ctx.P.OWNER).get(list)).status(200).json<any[]>();
        const row = rows.find((t) => t.token_id === tokenId);
        if (!row) throw new Error(`${list} misses the token`);
        if (row.workspace_id !== p.id) throw new Error(`${list} row workspace_id ${row.workspace_id}`);
      }
    });

    await ctx.step('the workspace key is fenced the same way under both names', async () => {
      const pat: Principal = { ...ctx.P.OWNER, auth: { mode: 'bearer', token: secret } };
      if ((await sameAnswer(ctx, pat, `/v1/projects/${p.id}/sessions`, `/v1/workspaces/${p.id}/sessions`)) !== 200) {
        throw new Error('own workspace refused');
      }
      // One rule (K1): a workspace key reaches every route of its own workspace,
      // the account family included; its holder's role decides.
      if ((await sameAnswer(ctx, pat, `/v1/accounts/${team.id}/members`, `/v1/workspaces/${p.id}/members`)) !== 200) {
        throw new Error('own account family refused');
      }
      const listed = (await ctx.client.as(pat).get('/v1/projects')).status(200).json<any[]>();
      if (listed.some((w) => w.project_id !== p.id)) throw new Error('a workspace key listed another workspace');
      if ((await sameAnswer(ctx, pat, '/v1/accounts/me', '/v1/me')) !== 200) throw new Error('identity probe refused');
    });

    await ctx.step('a key minted under a workspace path is bound to that workspace; a legacy account key names its workspace on /v1/accounts only', async () => {
      const expires_at = new Date(Date.now() + 3_600_000).toISOString();
      // A legacy account (split_pending): two projects, two workspaces.
      const legacy = await ctx.fixtures.team();
      const a = await legacy.project();
      const b = await legacy.project();
      for (const base of ['/v1/workspaces', '/v1/accounts']) {
        const minted = await ctx.client.as(ctx.P.OWNER).post(`${base}/${a.id}/tokens`, { name: 'ws-route-3-bound', expires_at });
        minted.status(201).body().has('$.project_id', a.id);
        const pat: Principal = { ...ctx.P.OWNER, auth: { mode: 'bearer', token: minted.json<any>().secret_key } };
        (await ctx.client.as(pat).get(`/v1/workspaces/${a.id}/sessions`)).status(200);
        (await ctx.client.as(pat).get(`/v1/workspaces/${b.id}/sessions`)).status(403);
      }
      // The legacy account key names two workspaces: say which (legacy name), and the 409 lists no ids.
      const ambiguous = await ctx.client.as(ctx.P.OWNER).post(`/v1/accounts/${legacy.id}/tokens`, { name: 'ws-route-3-ambiguous', expires_at });
      ambiguous.status(409).body().has('$.code', 'workspace_ambiguous');
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/accounts/${legacy.id}/tokens`, { name: 'ws-route-3-named', expires_at, project_id: b.id }))
        .status(201).body().has('$.project_id', b.id);
      // The canonical name never takes an account key.
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${legacy.id}/tokens`, { name: 'ws-route-3-key', expires_at }))
        .status(404).body().has('$.code', 'workspace_not_found');
      // project_id must name the workspace in the path.
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${a.id}/tokens`, { name: 'ws-route-3-other', expires_at, project_id: b.id }))
        .status(400);
      // A 1:1 workspace named by its account key on the legacy name binds to its one project.
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/accounts/${team.id}/tokens`, { name: 'ws-route-3-key', expires_at }))
        .status(201).body().has('$.project_id', p.id);
      // The older route keeps minting a personal key.
      (await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', { name: 'ws-route-3-account', expires_at, account_id: legacy.id }))
        .status(201).body().has('$.project_id', null);
    });

    await ctx.step('revoking under /v1/workspaces/:id/tokens kills the token on every name', async () => {
      (await ctx.client.as(ctx.P.OWNER).del(`/v1/workspaces/${p.id}/tokens/${tokenId}`)).status(200).body().has('$.ok', true);
      (await ctx.client.as(ctx.P.OWNER).del(`/v1/accounts/${team.id}/tokens/${tokenId}`)).status(404);
      const rows = (await ctx.client.as(ctx.P.OWNER).get(`/v1/accounts/${team.id}/tokens`)).status(200).json<any[]>();
      if (rows.some((t) => t.token_id === tokenId)) throw new Error('revoked token still listed');
      const pat: Principal = { ...ctx.P.OWNER, auth: { mode: 'bearer', token: secret } };
      (await ctx.client.as(pat).get(`/v1/workspaces/${p.id}/sessions`)).status(401);
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/accounts/${team.id}/tokens`, { name: '' })).status(400);
      (await ctx.client.as(ctx.P.NONMEMBER).get(`/v1/accounts/${team.id}/tokens`)).status(403);
      await notFound(ctx, ctx.P.NONMEMBER, `/v1/workspaces/${p.id}/tokens`);
    });
  },
);

flow(
  'WS-ROUTE-4',
  { domain: 'workspaces', routes: ['GET /v1/workspaces', 'GET /v1/projects'] },
  async (ctx) => {
    const teams = await Promise.all([ctx.fixtures.team(), ctx.fixtures.team(), ctx.fixtures.team()]);
    const workspaces = await Promise.all(teams.map((team) => team.project()));

    await ctx.step('one GET /v1/workspaces lists the workspaces of 3 accounts, each with its own account_id', async () => {
      const list = (await ctx.client.as(ctx.P.OWNER).get('/v1/workspaces')).status(200).json<any[]>();
      for (const [index, ws] of workspaces.entries()) {
        const row = list.find((w) => w.workspace_id === ws.id);
        if (!row) throw new Error(`workspace ${index + 1} of 3 missing from one GET /v1/workspaces`);
        if (row.account_id !== teams[index]!.id || row.role !== 'owner' || row.state !== 'active') {
          throw new Error(`row ${index + 1}: ${row.account_id} ${row.role} ${row.state}`);
        }
      }
      // The order: most recently opened first, never-opened last, then name, then id.
      const opened = list.map((w) => (w.last_opened_at ? Date.parse(w.last_opened_at) : null));
      for (let i = 1; i < opened.length; i += 1) {
        const a = opened[i - 1];
        const b = opened[i];
        if (a === null && b !== null) throw new Error(`a never-opened workspace sorts before an opened one at ${i}`);
        if (a !== null && b !== null && a < b) throw new Error(`list not most-recent-first at ${i}`);
      }
    });

    await ctx.step('the legacy GET /v1/projects?account_id= lists one account only', async () => {
      const legacy = (await ctx.client.as(ctx.P.OWNER).get('/v1/projects', { query: { account_id: teams[0]!.id } })).status(200).json<any[]>();
      if (legacy.map((r) => r.project_id).join() !== workspaces[0]!.id) throw new Error(`legacy list ${legacy.map((r) => r.project_id)}`);
    });

    await ctx.step('a workspace key lists exactly its one workspace', async () => {
      const minted = await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${workspaces[1]!.id}/tokens`, {
        name: 'ws-route-4',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const pat: Principal = { ...ctx.P.OWNER, auth: { mode: 'bearer', token: minted.status(201).json<any>().secret_key } };
      const list = (await ctx.client.as(pat).get('/v1/workspaces')).status(200).json<any[]>();
      if (list.length !== 1 || list[0].workspace_id !== workspaces[1]!.id) throw new Error(`bound list ${list.map((r) => r.workspace_id)}`);
      (await ctx.client.as(ctx.P.OWNER).del(`/v1/workspaces/${workspaces[1]!.id}/tokens/${minted.json<any>().token_id}`)).status(200);
    });
  },
);

flow(
  'WS-ROUTE-5',
  {
    domain: 'workspaces',
    requires: ['managedGit'],
    serial: true,
    routes: ['POST /v1/workspaces', 'GET /v1/workspaces/:workspaceId', 'DELETE /v1/workspaces/:workspaceId'],
  },
  async (ctx) => {
    let created = '';
    await ctx.step('POST /v1/workspaces creates a new workspace with its own new account and answers the Workspace (201)', async () => {
      const before = (await ctx.client.as(ctx.P.OWNER).get('/v1/workspaces')).status(200).json<any[]>();
      const r = await ctx.client.as(ctx.P.OWNER).post('/v1/workspaces', { name: ctx.fixtures.name('ws-create'), idempotency_key: ctx.fixtures.name('ws-create-key') });
      r.status(201).body().has('$.role', 'owner').has('$.state', 'active').exists('$.workspace.member_count');
      const ws = r.json<any>();
      created = ws.workspace_id;
      ctx.track('project', created);
      if (ws.project_id !== ws.workspace_id) throw new Error('workspace_id is not the project id');
      if (before.some((w) => w.account_id === ws.account_id)) throw new Error('the create reused an account the caller already had');
      (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${created}`)).status(200).body().has('$.workspace_id', created);
    });

    await ctx.step('Accept: text/event-stream streams the phases and ends with a done frame carrying the workspace', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/workspaces',
        { name: ctx.fixtures.name('ws-create-sse') },
        { headers: { Accept: 'text/event-stream' } },
      );
      r.status(200);
      const frames = r
        .text()
        .split('\n\n')
        .map((frame) => frame.replace(/^data: /, ''))
        .filter(Boolean)
        .map((json) => JSON.parse(json));
      if (!frames.some((f) => f.type === 'phase')) throw new Error('no phase frame');
      const done = frames.at(-1);
      if (done?.type !== 'done' || done.workspace?.workspace_id !== done.project?.project_id || done.workspace?.role !== 'owner') {
        throw new Error(`last frame ${JSON.stringify(done).slice(0, 300)}`);
      }
      ctx.track('project', done.project.project_id);
    });
  },
);

flow(
  'WS-ROUTE-6',
  {
    domain: 'workspaces',
    routes: [
      'GET /v1/workspaces/:workspaceId',
      'GET /v1/workspaces/:workspaceId/sessions',
      'GET /v1/workspaces/:workspaceId/members',
      'GET /v1/workspaces/:workspaceId/iam/groups',
      'GET /v1/connectors/workspaces/:workspaceId/connectors',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    const foreignTeam = await ctx.fixtures.team();
    const foreign = await foreignTeam.project();
    const tails = ['', '/sessions', '/members', '/iam/groups'];

    await ctx.step('an account id, an unknown id and a foreign workspace each answer 404 workspace_not_found on every sub-path', async () => {
      for (const tail of tails) {
        await notFound(ctx, ctx.P.OWNER, `/v1/workspaces/${team.id}${tail}`);
        await notFound(ctx, ctx.P.OWNER, `/v1/workspaces/${randomId()}${tail}`);
        await notFound(ctx, ctx.P.NONMEMBER, `/v1/workspaces/${foreign.id}${tail}`);
      }
      await notFound(ctx, ctx.P.OWNER, `/v1/connectors/workspaces/${team.id}/connectors`);
      await notFound(ctx, ctx.P.NONMEMBER, `/v1/connectors/workspaces/${p.id}/connectors`);
    });

    await ctx.step('the workspace id answers on every sub-path, in any letter case', async () => {
      for (const tail of tails) {
        (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${p.id}${tail}`)).status(200);
        (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${p.id.toUpperCase()}${tail}`)).status(200);
      }
      (await ctx.client.as(ctx.P.OWNER).get(`/v1/connectors/workspaces/${p.id}/connectors`)).status(200);
    });

    await ctx.step('the legacy names keep either id and their old answers', async () => {
      (await ctx.client.as(ctx.P.OWNER).get(`/v1/accounts/${team.id}/members`)).status(200);
      (await ctx.client.as(ctx.P.OWNER).get(`/v1/accounts/${p.id}/members`)).status(200);
      const unknown = await ctx.client.as(ctx.P.OWNER).get(`/v1/projects/${randomId()}`);
      unknown.status(404);
      if (unknown.json<any>()?.code === 'workspace_not_found') throw new Error('the legacy record changed its 404 body');
    });
  },
);

flow(
  'WS-ROUTE-7',
  {
    domain: 'workspaces',
    routes: [
      'PATCH /v1/workspaces/:workspaceId',
      'PATCH /v1/projects/:workspaceId',
      'PATCH /v1/workspaces/:workspaceId/iam/session-policy',
      'GET /v1/workspaces/:workspaceId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    // A rename commits kortix.yaml: the project needs a Git remote that takes a push.
    const p = await team.project({ managedGit: true });
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('PATCH with a settings key → 400 workspace_setting_read_only naming the field and its writer; nothing is written', async () => {
      const r = await owner.patch(`/v1/workspaces/${p.id}`, { session_idle_timeout_minutes: 30, name: ctx.fixtures.name('never') });
      r.status(400)
        .body()
        .has('$.code', 'workspace_setting_read_only')
        .has('$.field', 'session_idle_timeout_minutes')
        .has('$.writer', 'PATCH /v1/workspaces/:workspaceId/iam/session-policy');
      const ws = (await owner.get(`/v1/workspaces/${p.id}`)).status(200).json<any>();
      if (ws.name === ctx.fixtures.name('never')) throw new Error('a refused PATCH renamed the workspace');
      (await owner.patch(`/v1/workspaces/${p.id}`, { mfa_required: true })).status(400).body().has('$.field', 'mfa_required');
    });

    await ctx.step('the sub-route writes the setting, and GET /v1/workspaces/:id reads it back', async () => {
      (await owner.patch(`/v1/workspaces/${p.id}/iam/session-policy`, { idle_timeout_minutes: 45 })).status(200);
      const ws = (await owner.get(`/v1/workspaces/${p.id}`)).status(200).json<any>();
      if (ws.workspace?.session_idle_timeout_minutes !== 45) throw new Error(`read back ${ws.workspace?.session_idle_timeout_minutes}`);
      (await owner.patch(`/v1/workspaces/${p.id}/iam/session-policy`, { idle_timeout_minutes: null })).status(200);
    });

    await ctx.step('PATCH name and secret_default_strategy → 200 with the Workspace; the legacy PATCH keeps ignoring a settings key', async () => {
      const name = ctx.fixtures.name('renamed');
      const r = await owner.patch(`/v1/workspaces/${p.id}`, { name, secret_default_strategy: 'broker' });
      r.status(200).body().has('$.name', name).has('$.secret_default_strategy', 'broker').has('$.role', 'owner').exists('$.workspace');
      (await owner.patch(`/v1/workspaces/${p.id}`, { secret_default_strategy: 'nope' })).status(400);
      (await owner.patch(`/v1/projects/${p.id}`, { mfa_required: true })).status(200);
      (await owner.patch(`/v1/workspaces/${p.id}`, { secret_default_strategy: 'runtime' })).status(200);
    });
  },
);

flow(
  'WS-ROUTE-8',
  {
    domain: 'workspaces',
    requires: ['database'],
    routes: [
      'GET /v1/workspaces/:workspaceId/sessions',
      'GET /v1/sessions/:sessionId',
      'GET /v1/workspaces/:workspaceId/access',
      'GET /v1/workspaces/:workspaceId/members',
      'GET /v1/workspaces/:workspaceId/tokens',
      'GET /v1/workspaces',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    const sessionId = await createDatabaseSession(ctx.env, { projectId: p.id, accountId: team.id, userId: ctx.P.OWNER.userId! });
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('every row that names the workspace carries workspace_id = project_id', async () => {
      const sessions = (await owner.get(`/v1/workspaces/${p.id}/sessions`)).status(200).json<any>();
      const rows: any[] = Array.isArray(sessions) ? sessions : (sessions.sessions ?? sessions.items ?? []);
      const row = rows.find((s) => s.session_id === sessionId);
      if (!row || row.workspace_id !== p.id || row.project_id !== p.id) throw new Error(`session row ${JSON.stringify(row ?? rows[0] ?? null).slice(0, 200)}`);
      (await owner.get(`/v1/sessions/${sessionId}`)).status(200).body().has('$.workspace_id', p.id);
      (await owner.get(`/v1/workspaces/${p.id}/access`)).status(200).body().has('$.workspace_id', p.id);
      const members = (await owner.get(`/v1/workspaces/${p.id}/members`)).status(200).json<any[]>();
      const grants = members.flatMap((m) => m.projects ?? []);
      if (grants.length === 0 || grants.some((g: any) => g.workspace_id !== g.project_id)) throw new Error(`member grants ${JSON.stringify(grants).slice(0, 200)}`);
    });

    await ctx.step('the workspace record and list carry one top-level role on the ladder', async () => {
      const member = await team.addMember('member');
      await team.grantProjectRole(p.id, member.userId!, 'manager');
      const asMember = ctx.client.as(member);
      (await asMember.get(`/v1/workspaces/${p.id}`)).status(200).body().has('$.role', 'manager');
      const row = (await asMember.get('/v1/workspaces')).status(200).json<any[]>().find((w) => w.workspace_id === p.id);
      if (row?.role !== 'manager') throw new Error(`list role ${row?.role}`);
      (await owner.get(`/v1/workspaces/${p.id}`)).status(200).body().has('$.role', 'owner');
    });
  },
);

flow(
  'WS-ROUTE-9',
  {
    domain: 'workspaces',
    routes: ['POST /v1/workspaces', 'GET /v1/projects/quota', 'POST /v1/projects/provision'],
  },
  async (ctx) => {
    await ctx.step('POST /v1/workspaces refuses an empty name and an account_id (400), and a workspace key (403 new_workspace_requires_person)', async () => {
      (await ctx.client.as(ctx.P.OWNER).post('/v1/workspaces', { name: '  ' })).status(400);
      (await ctx.client.as(ctx.P.OWNER).post('/v1/workspaces', { name: ctx.fixtures.name('x'), account_id: ctx.P.accountId }))
        .status(400).body().has('$.code', 'new_workspace_with_account_id');
      const team = await ctx.fixtures.team();
      const p = await team.project();
      const minted = await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${p.id}/tokens`, {
        name: 'ws-route-9',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const pat: Principal = { ...ctx.P.OWNER, auth: { mode: 'bearer', token: minted.status(201).json<any>().secret_key } };
      (await ctx.client.as(pat).post('/v1/workspaces', { name: ctx.fixtures.name('y') })).status(403).body().has('$.code', 'new_workspace_requires_person');
      (await ctx.client.as(ctx.P.ANON).post('/v1/workspaces', { name: ctx.fixtures.name('z') })).status(401);
    });

    await ctx.step('the account-scoped create and quota routes are legacy names only: /v1/workspaces/<name> is no workspace', async () => {
      for (const path of ['/v1/workspaces/quota', '/v1/workspaces/provision']) {
        (await ctx.client.as(ctx.P.OWNER).get(path)).status(404);
      }
      (await ctx.client.as(ctx.P.OWNER).post('/v1/workspaces/provision', { name: ctx.fixtures.name('p') })).status(404);
      (await ctx.client.as(ctx.P.OWNER).get('/v1/projects/quota')).status(200).body().has('$.limit', 1);
    });
  },
);

// ── WS-ROUTE-10 — the person's personal keys: GET/DELETE /v1/me/tokens ──────
flow(
  'WS-ROUTE-10',
  {
    domain: 'workspaces',
    requires: ['database'],
    routes: [
      'GET /v1/billing/account-state',
      'POST /v1/accounts/tokens',
      'POST /v1/workspaces/:workspaceId/tokens',
      'GET /v1/me/tokens',
      'GET /v1/accounts/me/tokens',
      'DELETE /v1/me/tokens/:tokenId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const expires_at = new Date(Date.now() + 3_600_000).toISOString();
    let personalId = '';
    let workspaceKey = '';
    let workspaceKeyId = '';

    await ctx.step('the owner mints a personal key and a workspace key', async () => {
      const personal = await owner.post('/v1/accounts/tokens', { name: 'wsr10-personal', account_id: team.id, expires_at });
      personal.status(201).body().has('$.project_id', null);
      personalId = personal.json<{ token_id: string }>().token_id;
      const scoped = await owner.post(`/v1/workspaces/${w.id}/tokens`, { name: 'wsr10-workspace', expires_at });
      scoped.status(201);
      workspaceKey = scoped.json<{ secret_key: string }>().secret_key;
      workspaceKeyId = scoped.json<{ token_id: string }>().token_id;
    });

    await ctx.step('GET /v1/me/tokens → 200 lists the personal key (workspace_id null), never the workspace key; the /v1/accounts/me alias answers the same', async () => {
      const list = (await owner.get('/v1/me/tokens')).status(200).json<Array<{ token_id: string; workspace_id: string | null; status: string }>>();
      const mine = list.find((t) => t.token_id === personalId);
      if (!mine || mine.workspace_id !== null || mine.status !== 'active') throw new Error(`personal key row ${JSON.stringify(mine)}`);
      if (list.some((t) => t.token_id === workspaceKeyId)) throw new Error('a workspace key is listed as personal');
      const alias = (await owner.get('/v1/accounts/me/tokens')).status(200).json<Array<{ token_id: string }>>();
      if (!alias.some((t) => t.token_id === personalId)) throw new Error('the /v1/accounts/me/tokens alias does not list the key');
    });

    await ctx.step('a workspace key may not read the person’s keys → 403', async () => {
      (await ctx.client.withBearer(workspaceKey, 'WSR10_KEY').get('/v1/me/tokens')).status(403);
    });

    await ctx.step('DELETE /v1/me/tokens/:id → 200; the key reads revoked; a second revoke → 404; another person → 404', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).del(`/v1/me/tokens/${personalId}`)).status(404);
      (await owner.del(`/v1/me/tokens/${personalId}`)).status(200).body().has('$.ok', true);
      const list = (await owner.get('/v1/me/tokens')).status(200).json<Array<{ token_id: string; status: string }>>();
      if (list.find((t) => t.token_id === personalId)?.status !== 'revoked') throw new Error('the key is not revoked');
      (await owner.del(`/v1/me/tokens/${personalId}`)).status(404);
      (await owner.del('/v1/me/tokens/not-a-uuid')).status(400);
    });

    await ctx.step('GET /billing/account-state?workspace_id= answers for that workspace, like ?account_id=; never the default one', async () => {
      const funded = await ctx.fixtures.team();
      const fundedWorkspace = await funded.project();
      await fundDatabaseAccount(ctx.env, funded.id);
      const read = async (query: Record<string, string>) =>
        stable((await owner.get('/v1/billing/account-state', { query })).status(200).text());
      const [byWorkspace, byAccount, other] = await Promise.all([
        read({ workspace_id: fundedWorkspace.id }),
        read({ account_id: funded.id }),
        read({ workspace_id: w.id }),
      ]);
      if (byWorkspace !== byAccount) throw new Error('?workspace_id= and ?account_id= answer different states');
      if (byWorkspace === other) throw new Error('?workspace_id= answered another workspace');
    });
  },
);

// ── WS-ROUTE-11 — a legacy account route needs no project_id on a 1:1 workspace ──
flow(
  'WS-ROUTE-11',
  {
    domain: 'workspaces',
    routes: [
      'GET /v1/workspaces/:workspaceId/subscription-connections',
      'GET /v1/accounts/:workspaceId/subscription-connections',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const w = await team.project();
    await ctx.step('GET /accounts/:team/subscription-connections (no project_id) answers like /workspaces/:w/subscription-connections → 200', async () => {
      const status = await sameAnswer(ctx, ctx.P.OWNER, `/v1/accounts/${team.id}/subscription-connections`, `/v1/workspaces/${w.id}/subscription-connections`);
      if (status !== 200) throw new Error(`expected 200, got ${status}`);
    });
  },
);
