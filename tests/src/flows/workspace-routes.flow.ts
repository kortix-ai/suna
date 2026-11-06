/**
 * Workspace route names (spec §4a, `WS-ROUTE-*`). `/v1/workspaces` is the
 * canonical name of every workspace route. The old names stay mounted
 * permanently. Each flow calls BOTH names of a route and asserts the same
 * status and the same body, so an alias can never drift from its route.
 *
 * Every other flow calls the canonical names
 * (`scripts/codemods/workspace-flow-routes.ts`); accounts, connectors, secrets
 * and retired flows keep the legacy names.
 */
import { flow } from '../core/flow';
import type { FlowContext, Principal } from '../core/types';

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

    await ctx.step('the workspace list is the project list under both names, with workspace_id', async () => {
      const list = await ctx.client.as(ctx.P.OWNER).get('/v1/workspaces', { query: { account_id: team.id } });
      list.status(200);
      const row = list.json<any[]>().find((w) => w.project_id === p.id);
      if (!row) throw new Error('the workspace is missing from GET /v1/workspaces');
      if (row.workspace_id !== p.id || row.account_id !== team.id) {
        throw new Error(`workspace_id ${row.workspace_id} / account_id ${row.account_id}`);
      }
      const legacy = (await ctx.client.as(ctx.P.OWNER).get('/v1/projects', { query: { account_id: team.id } })).status(200).json<any[]>();
      if (!legacy.some((w) => w.project_id === p.id && w.workspace_id === p.id)) throw new Error('GET /v1/projects lost the workspace');
      // `account_id` also takes the workspace id.
      const byWorkspaceId = await ctx.client.as(ctx.P.OWNER).get('/v1/workspaces', { query: { account_id: p.id } });
      if (!byWorkspaceId.status(200).json<any[]>().some((w) => w.project_id === p.id)) throw new Error('account_id=<workspace id> missed the workspace');
    });

    await ctx.step('project-family reads answer identically under /v1/projects and /v1/workspaces', async () => {
      for (const tail of ['sessions', 'secrets', 'access']) {
        const status = await sameAnswer(ctx, ctx.P.OWNER, `/v1/projects/${p.id}/${tail}`, `/v1/workspaces/${p.id}/${tail}`);
        if (status !== 200) throw new Error(`${tail} → ${status}`);
      }
    });

    await ctx.step('GET /v1/workspaces/:id is the project record plus the workspace settings', async () => {
      const ws = (await ctx.client.as(ctx.P.OWNER).get(`/v1/workspaces/${p.id}`)).status(200).json<any>();
      if (ws.project_id !== p.id || ws.workspace_id !== p.id) throw new Error(`ids ${ws.project_id} ${ws.workspace_id}`);
      if (ws.workspace?.workspace_id !== p.id || ws.workspace?.account_id !== team.id || ws.workspace?.split_pending !== false) {
        throw new Error(`settings block ${JSON.stringify(ws.workspace)}`);
      }
      if (typeof ws.workspace.mfa_required !== 'boolean' || typeof ws.workspace.member_count !== 'number') {
        throw new Error(`settings fields ${JSON.stringify(ws.workspace)}`);
      }
      // The caller's own account role: the SDK's getWorkspace derives the role from it in one request.
      if (ws.workspace.account_role !== 'owner') throw new Error(`account_role ${ws.workspace.account_role}`);
      const legacy = (await ctx.client.as(ctx.P.OWNER).get(`/v1/projects/${p.id}`)).status(200).json<any>();
      if ('workspace' in legacy || legacy.workspace_id !== p.id) throw new Error('legacy record shape changed');
    });

    await ctx.step('a non-member is refused the same way under both names', async () => {
      for (const tail of ['', '/sessions']) {
        const status = await sameAnswer(ctx, ctx.P.NONMEMBER, `/v1/projects/${p.id}${tail}`, `/v1/workspaces/${p.id}${tail}`);
        if (status !== 403 && status !== 404) throw new Error(`non-member ${tail || 'record'} → ${status}`);
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

    await ctx.step('an account family answers the same by account key and by workspace id', async () => {
      for (const tail of ['members', 'iam/roles', 'invites', 'branding']) {
        const legacy = `/v1/accounts/${team.id}/${tail}`;
        const status = await sameAnswer(ctx, ctx.P.OWNER, legacy, `/v1/workspaces/${p.id}/${tail}`);
        if (status !== 200) throw new Error(`${tail} → ${status}`);
        // Either key names the workspace on every name.
        await sameAnswer(ctx, ctx.P.OWNER, legacy, `/v1/workspaces/${team.id}/${tail}`);
        await sameAnswer(ctx, ctx.P.OWNER, legacy, `/v1/accounts/${p.id}/${tail}`);
      }
    });

    await ctx.step('a non-member is refused the same way by either key', async () => {
      const status = await sameAnswer(ctx, ctx.P.NONMEMBER, `/v1/accounts/${team.id}/members`, `/v1/workspaces/${p.id}/members`);
      if (status !== 403) throw new Error(`non-member members → ${status}`);
    });

    await ctx.step('an account key with no workspace still answers its account routes', async () => {
      const dormant = await ctx.fixtures.team();
      const status = await sameAnswer(ctx, ctx.P.OWNER, `/v1/accounts/${dormant.id}/members`, `/v1/workspaces/${dormant.id}/members`);
      if (status !== 200) throw new Error(`dormant members → ${status}`);
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
      if ((await sameAnswer(ctx, ctx.P.OWNER, '/v1/accounts/me', '/v1/me')) !== 200) throw new Error('/v1/me');
      if ((await sameAnswer(ctx, ctx.P.OWNER, '/v1/account-invites', '/v1/invites')) !== 200) throw new Error('/v1/invites');
      const me = (await ctx.client.as(ctx.P.OWNER).get('/v1/me')).json<any>();
      const membership = (me.accounts as any[]).find((a) => a.account_id === team.id);
      if (membership?.workspace_id !== p.id) throw new Error(`me.accounts workspace_id ${membership?.workspace_id}`);
    });

    let tokenId = '';
    let secret = '';
    await ctx.step('a project PAT minted under /v1/workspaces/:id/tokens lists under every token name', async () => {
      const minted = await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${p.id}/tokens`, {
        name: 'ws-route-3',
        project_id: p.id,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      minted.status(201).body().has('$.project_id', p.id).exists('$.secret_key');
      tokenId = minted.json<any>().token_id;
      secret = minted.json<any>().secret_key;
      for (const list of [
        `/v1/workspaces/${p.id}/tokens`,
        `/v1/accounts/${team.id}/tokens`,
        `/v1/accounts/tokens?account_id=${team.id}`,
        `/v1/accounts/tokens?account_id=${p.id}`,
      ]) {
        const rows = (await ctx.client.as(ctx.P.OWNER).get(list)).status(200).json<any[]>();
        if (!rows.some((t) => t.token_id === tokenId)) throw new Error(`${list} misses the token`);
      }
    });

    await ctx.step('the project PAT is fenced the same way under both names', async () => {
      const pat: Principal = { ...ctx.P.OWNER, auth: { mode: 'bearer', token: secret } };
      if ((await sameAnswer(ctx, pat, `/v1/projects/${p.id}/sessions`, `/v1/workspaces/${p.id}/sessions`)) !== 200) {
        throw new Error('own workspace refused');
      }
      if ((await sameAnswer(ctx, pat, `/v1/accounts/${team.id}/members`, `/v1/workspaces/${p.id}/members`)) !== 403) {
        throw new Error('account family not fenced');
      }
      if ((await sameAnswer(ctx, pat, '/v1/projects', '/v1/workspaces')) !== 403) throw new Error('list not fenced');
      if ((await sameAnswer(ctx, pat, '/v1/accounts/me', '/v1/me')) !== 200) throw new Error('identity probe refused');
    });

    await ctx.step('a PAT minted under a workspace path without project_id is bound to that workspace; /v1/accounts/tokens stays account-wide', async () => {
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
      // The account key of a legacy account names two workspaces: say which.
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${legacy.id}/tokens`, { name: 'ws-route-3-ambiguous', expires_at }))
        .status(409).body().has('$.code', 'workspace_ambiguous');
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${legacy.id}/tokens`, { name: 'ws-route-3-named', expires_at, project_id: b.id }))
        .status(201).body().has('$.project_id', b.id);
      // project_id must name the workspace in the path.
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${a.id}/tokens`, { name: 'ws-route-3-other', expires_at, project_id: b.id }))
        .status(400);
      // A 1:1 workspace named by its account key binds to its one project.
      (await ctx.client.as(ctx.P.OWNER).post(`/v1/workspaces/${team.id}/tokens`, { name: 'ws-route-3-key', expires_at }))
        .status(201).body().has('$.project_id', p.id);
      // The older route keeps minting an account-wide PAT.
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
      (await ctx.client.as(ctx.P.NONMEMBER).get(`/v1/workspaces/${p.id}/tokens`)).status(403);
    });
  },
);
