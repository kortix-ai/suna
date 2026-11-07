/**
 * The workspace lifecycle and "Delete my account" (spec §4a, `WS-LIFE-*`,
 * `DEL-7`, `DEL-8`; design.md §3.1 K2 and items 1, 2, 9).
 *
 * - A workspace's lifecycle is its account's: DELETE closes the account
 *   (14-day grace), an owner restores it, and a new workspace never reuses
 *   an account (WS-LIFE-1, WS-LIFE-2).
 * - A project-less workspace that pays is `setup_required` and is set up in
 *   place: project_id = workspace_id (WS-LIFE-3, WS-LIFE-4).
 * - "Delete my account" deletes the person: the workspaces they own alone go
 *   with them, they leave the others, the login goes last; a sole owner of a
 *   workspace other people use is refused with the list (DEL-7, DEL-8).
 *
 * Every person here is a fresh synthetic user; no shared principal is
 * deleted or closed.
 */
import { flow } from '../core/flow';
import type { FlowContext, Principal } from '../core/types';
import { withDb } from '../fixtures/chat';
import { PASSWORD } from '../fixtures/principals';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A password grant for `who`: 200 while the login exists, 400 after it is deleted. */
async function passwordGrantStatus(ctx: FlowContext, who: Principal): Promise<number> {
  if (!ctx.env.supabaseAnonKey || !who.email) throw new Error('the password grant needs the anon key and the email');
  const res = await fetch(`${ctx.env.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ctx.env.supabaseAnonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: who.email, password: PASSWORD }),
  });
  return res.status;
}

/** A second workspace of the person: an account they own and are the only member of. */
async function ownedAccount(ctx: FlowContext, who: Principal, slug: string): Promise<string> {
  const r = await ctx.client.as(who).post('/v1/accounts', { name: ctx.fixtures.name(slug) });
  r.status(201);
  const id = r.json<{ account_id: string }>().account_id;
  if (!id) throw new Error(`POST /v1/accounts returned no account_id: ${r.text()}`);
  return id;
}

async function accountRows(ctx: FlowContext, ids: string[]): Promise<number> {
  const rows = await withDb(ctx, (db) => db.query('SELECT 1 FROM kortix.accounts WHERE account_id = ANY($1::uuid[])', [ids]));
  return rows.rowCount ?? 0;
}

async function lifecycleOf(ctx: FlowContext, workspaceId: string): Promise<{ lifecycle: string; deletion_scheduled_for: string | null } | null> {
  const rows = await withDb(ctx, (db) =>
    db.query(
      `SELECT lifecycle, deletion_scheduled_for::text FROM kortix.workspaces
        WHERE workspace_id = $1::uuid AND lifecycle <> 'tombstone'`,
      [workspaceId],
    ),
  );
  return (rows.rows[0] as { lifecycle: string; deletion_scheduled_for: string | null } | undefined) ?? null;
}

flow(
  'WS-LIFE-1',
  {
    domain: 'workspaces',
    requires: ['managedGit'],
    routes: ['POST /v1/projects/provision', 'POST /v1/accounts/:accountId/members', 'DELETE /v1/workspaces/:workspaceId', 'GET /v1/workspaces/:workspaceId'],
  },
  async (ctx) => {
    const owner = await ctx.fixtures.user({ label: 'LIFE1-OWNER', noAccount: true });
    const admin = await ctx.fixtures.user({ label: 'LIFE1-ADMIN', noAccount: true });
    const asOwner = ctx.client.as(owner);
    const create = async (slug: string) => {
      const r = await asOwner.post('/v1/projects/provision', { name: ctx.fixtures.name(slug), new_workspace: true });
      r.status(201);
      const body = r.json<{ project_id: string; account_id: string }>();
      ctx.track('project', body.project_id);
      return body;
    };

    let w1: { project_id: string; account_id: string };
    await ctx.step('two creates make two workspaces, each with a new account', async () => {
      w1 = await create('life1-a');
      const w = await create('life1-b');
      if (w.account_id === w1.account_id) throw new Error(`two creates shared account ${w1.account_id}`);
    });
    await ctx.step('the owner adds an admin to W1, then deletes W1 → 200 with a deletion date 14 days out', async () => {
      (await asOwner.post('/v1/accounts/:accountId/members', { email: admin.email, role: 'admin' }, { params: { accountId: w1.account_id } }))
        .status(201);
      const r = await asOwner.del('/v1/workspaces/:workspaceId', { params: { workspaceId: w1.project_id } });
      r.status(200).body().has('$.deleted', true).has('$.repo_deleted', false).exists('$.deletion_scheduled_for');
    });
    await ctx.step('a create after the delete never lands in the deleted account; the old admin cannot read the new workspace', async () => {
      const w2 = await create('life1-c');
      if (w2.account_id === w1.account_id) throw new Error('the new workspace reused the deleted workspace account');
      (await ctx.client.as(admin).get('/v1/workspaces/:workspaceId', { params: { workspaceId: w2.project_id } })).status([403, 404]);
    });
  },
);

flow(
  'WS-LIFE-2',
  {
    domain: 'workspaces',
    requires: ['database'],
    routes: [
      'DELETE /v1/workspaces/:workspaceId',
      'PATCH /v1/workspaces/:workspaceId/members/:userId',
      'POST /v1/workspaces/:workspaceId/restore',
      'GET /v1/workspaces/:workspaceId',
      'GET /v1/workspaces',
      'GET /v1/accounts',
      'GET /v1/accounts/:workspaceId',
      'GET /v1/billing/account-state',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    const admin = await team.addMember('admin');
    const asOwner = ctx.client.as(ctx.P.OWNER);
    const params = { workspaceId: p.id };

    await ctx.step('only an owner deletes: the admin and a manager → 403, the workspace stays active', async () => {
      const manager = await team.addMember('member');
      (await asOwner.patch('/v1/workspaces/:workspaceId/members/:userId', { role: 'manager' }, { params: { ...params, userId: manager.userId! } })).status(200);
      for (const who of [admin, manager]) {
        (await ctx.client.as(who).del('/v1/workspaces/:workspaceId', { params })).status(403);
      }
      const row = await lifecycleOf(ctx, p.id);
      if (row?.lifecycle !== 'active') throw new Error(`workspace row ${JSON.stringify(row)}`);
    });
    await ctx.step('an owner restores nothing while the workspace is live → 409 workspace_not_deleting', async () => {
      (await asOwner.post('/v1/workspaces/:workspaceId/restore', {}, { params })).status(409).body().has('$.code', 'workspace_not_deleting');
    });
    await ctx.step('DELETE → 200 {deleted, archived, repo_deleted:false, deletion_scheduled_for ≈ now + 14 d}; the workspace is closing', async () => {
      const r = await asOwner.del('/v1/workspaces/:workspaceId', { params });
      r.status(200).body().has('$.ok', true).has('$.deleted', true).has('$.archived', true).has('$.repo_deleted', false);
      const when = Date.parse(r.json<{ deletion_scheduled_for: string }>().deletion_scheduled_for);
      if (!(Math.abs(when - (Date.now() + 14 * DAY_MS)) < DAY_MS)) throw new Error(`deletion_scheduled_for ${new Date(when).toISOString()}`);
      const row = await lifecycleOf(ctx, p.id);
      if (row?.lifecycle !== 'closing' || !row.deletion_scheduled_for) throw new Error(`workspace row ${JSON.stringify(row)}`);
    });
    await ctx.step('the admin member loses the workspace at once → 404, and cannot restore it → 404 workspace_not_found', async () => {
      (await ctx.client.as(admin).get('/v1/workspaces/:workspaceId', { params })).status(404);
      // The legacy account names answer the same: no former member reads the closed account.
      for (const path of [`/v1/accounts/${team.id}`, `/v1/accounts/${team.id}/members`, `/v1/accounts/${team.id}/invites`]) {
        const r = await ctx.client.as(admin).get(path);
        if (r.statusCode !== 404 && r.statusCode !== 403) throw new Error(`${path} answered the admin ${r.statusCode}`);
      }
      (await ctx.client.as(admin).get('/v1/billing/account-state', { query: { account_id: team.id } })).status(403);
      // The owner still reads its billing while it can restore it.
      (await asOwner.get('/v1/billing/account-state', { query: { account_id: team.id } })).status(200);
      (await ctx.client.as(admin).post('/v1/workspaces/:workspaceId/restore', {}, { params }))
        .status(404)
        .body()
        .has('$.code', 'workspace_not_found');
    });
    await ctx.step('only the owner still sees it: its record answers state deleting, a sub-path 409 workspace_deleting, GET /workspaces names it deleting with its date, GET /accounts names the team; the admin lists neither', async () => {
      (await asOwner.get('/v1/workspaces/:workspaceId', { params }))
        .status(200)
        .body()
        .has('$.workspace_id', p.id)
        .has('$.state', 'deleting')
        .has('$.role', 'owner');
      (await asOwner.get('/v1/workspaces/:workspaceId/sessions', { params })).status(409).body().has('$.code', 'workspace_deleting');
      const ownerList = (await asOwner.get('/v1/workspaces')).status(200).json<Array<{ workspace_id: string; state: string; deletion_scheduled_for: string | null }>>();
      const mine = ownerList.find((w) => w.workspace_id === p.id);
      if (mine?.state !== 'deleting' || !mine.deletion_scheduled_for) throw new Error(`owner list item ${JSON.stringify(mine)}`);
      const adminList = (await ctx.client.as(admin).get('/v1/workspaces')).status(200).json<Array<{ workspace_id: string }>>();
      if (adminList.some((w) => w.workspace_id === p.id)) throw new Error('the admin still lists the deleted workspace');
      const ownerAccounts = (await asOwner.get('/v1/accounts')).status(200).json<Array<{ account_id: string }>>();
      if (!ownerAccounts.some((a) => a.account_id === team.id)) throw new Error('the owner no longer lists the team account');
      const adminAccounts = (await ctx.client.as(admin).get('/v1/accounts')).status(200).json<Array<{ account_id: string }>>();
      if (adminAccounts.some((a) => a.account_id === team.id)) throw new Error('the admin still lists the closing team account');
    });
    await ctx.step('a second DELETE: the owner → 409 workspace_deleting (restore it first), the admin → 404', async () => {
      (await asOwner.del('/v1/workspaces/:workspaceId', { params })).status(409).body().has('$.code', 'workspace_deleting');
      (await ctx.client.as(admin).del('/v1/workspaces/:workspaceId', { params })).status(404);
    });
    await ctx.step('the owner restores it → 200 active with the same id; the member reads it again', async () => {
      const r = await asOwner.post('/v1/workspaces/:workspaceId/restore', {}, { params });
      r.status(200).body().has('$.workspace_id', p.id).has('$.state', 'active').has('$.deletion_scheduled_for', null);
      (await asOwner.get('/v1/workspaces/:workspaceId', { params })).status(200).body().has('$.workspace_id', p.id);
      (await ctx.client.as(admin).get('/v1/workspaces/:workspaceId', { params })).status(200);
      const adminList = (await ctx.client.as(admin).get('/v1/workspaces')).status(200).json<Array<{ workspace_id: string; state: string }>>();
      if (adminList.find((w) => w.workspace_id === p.id)?.state !== 'active') throw new Error('the admin does not list the restored workspace as active');
      const row = await lifecycleOf(ctx, p.id);
      if (row?.lifecycle !== 'active' || row.deletion_scheduled_for !== null) throw new Error(`workspace row ${JSON.stringify(row)}`);
    });
  },
);

flow(
  'WS-LIFE-3',
  {
    domain: 'workspaces',
    requires: ['managedGit', 'database'],
    routes: ['POST /v1/accounts', 'POST /v1/workspaces/:workspaceId/setup', 'GET /v1/workspaces/:workspaceId'],
  },
  async (ctx) => {
    const owner = await ctx.fixtures.user({ label: 'LIFE3-OWNER' });
    const workspaceId = owner.accountId!;
    await ctx.step('a paying project-less workspace sets up in place → 201 with project_id = workspace_id', async () => {
      await withDb(ctx, (db) =>
        db.query(`UPDATE kortix.credit_accounts SET tier = 'tier_2_20' WHERE account_id = $1::uuid`, [workspaceId]),
      );
      const r = await ctx.client.as(owner).post('/v1/workspaces/:workspaceId/setup', { name: ctx.fixtures.name('life3') }, { params: { workspaceId } });
      r.status(201).body().has('$.project_id', workspaceId).has('$.workspace_id', workspaceId);
      ctx.track('project', workspaceId);
      (await ctx.client.as(owner).get('/v1/workspaces/:workspaceId', { params: { workspaceId } })).status(200).body().has('$.project_id', workspaceId);
    });
  },
);

flow(
  'WS-LIFE-4',
  {
    domain: 'workspaces',
    requires: ['database'],
    routes: ['POST /v1/workspaces/:workspaceId/setup', 'POST /v1/projects/:workspaceId/setup', 'GET /v1/workspaces/:workspaceId', 'GET /v1/workspaces'],
  },
  async (ctx) => {
    const owner = await ctx.fixtures.user({ label: 'LIFE4-OWNER' });
    const workspaceId = owner.accountId!;
    const setup = (who: Principal) =>
      ctx.client.as(who).post('/v1/workspaces/:workspaceId/setup', { name: ctx.fixtures.name('life4') }, { params: { workspaceId } });

    await ctx.step('a non-member → 404 workspace_not_found', async () => {
      (await setup(ctx.P.NONMEMBER)).status(404).body().has('$.code', 'workspace_not_found');
    });
    await ctx.step('a project-less workspace that does not pay is never served on a canonical path → 404 workspace_not_found; the legacy name answers 409 workspace_setup_not_required', async () => {
      (await setup(owner)).status(404).body().has('$.code', 'workspace_not_found');
      (await ctx.client.as(owner).post('/v1/projects/:workspaceId/setup', { name: ctx.fixtures.name('life4') }, { params: { workspaceId } }))
        .status(409)
        .body()
        .has('$.code', 'workspace_setup_not_required')
        .has('$.workspace_id', workspaceId);
    });
    await ctx.step('the same workspace once it pays: its record → 200 state setup_required, the list names it, a project-backed sub-path → 409 workspace_setup_required', async () => {
      (await ctx.client.as(owner).get('/v1/workspaces/:workspaceId', { params: { workspaceId } })).status(404);
      await withDb(ctx, (db) =>
        db.query(`UPDATE kortix.credit_accounts SET tier = 'tier_2_20' WHERE account_id = $1::uuid`, [workspaceId]),
      );
      (await ctx.client.as(owner).get('/v1/workspaces/:workspaceId', { params: { workspaceId } }))
        .status(200)
        .body()
        .has('$.workspace_id', workspaceId)
        .has('$.project_id', workspaceId)
        .has('$.state', 'setup_required')
        .has('$.role', 'owner');
      const listed = (await ctx.client.as(owner).get('/v1/workspaces')).status(200).json<Array<{ workspace_id: string; state: string }>>();
      if (listed.find((w) => w.workspace_id === workspaceId)?.state !== 'setup_required') {
        throw new Error(`list ${JSON.stringify(listed)}`);
      }
      (await ctx.client.as(owner).get('/v1/workspaces/:workspaceId/sessions', { params: { workspaceId } }))
        .status(409)
        .body()
        .has('$.code', 'workspace_setup_required');
    });
    await ctx.step('a workspace that has its project → 409 workspace_setup_not_required', async () => {
      const team = await ctx.fixtures.team();
      const p = await team.project();
      (await ctx.client.as(ctx.P.OWNER).post('/v1/workspaces/:workspaceId/setup', {}, { params: { workspaceId: p.id } }))
        .status(409)
        .body()
        .has('$.code', 'workspace_setup_not_required');
    });
  },
);

flow(
  'DEL-7',
  {
    domain: 'accounts',
    requires: ['database'],
    routes: ['GET /v1/account/deletion-plan', 'DELETE /v1/account/delete-immediately', 'POST /v1/accounts'],
  },
  async (ctx) => {
    const person = await ctx.fixtures.user({ label: 'DEL-7' });
    const first = person.accountId!;
    let second = '';

    await ctx.step('a person who owns two workspaces alone: the plan deletes both and blocks nothing', async () => {
      second = await ownedAccount(ctx, person, 'del7-second');
      const plan = (await ctx.client.as(person).get('/v1/account/deletion-plan')).status(200).json<{
        delete_workspaces: string[];
        leave_workspaces: string[];
        blockers: unknown[];
      }>();
      if ([...plan.delete_workspaces].sort().join() !== [first, second].sort().join()) {
        throw new Error(`delete_workspaces ${JSON.stringify(plan.delete_workspaces)}`);
      }
      if (plan.leave_workspaces.length || plan.blockers.length) throw new Error(`plan ${JSON.stringify(plan)}`);
    });
    await ctx.step('delete-immediately → 200; both accounts are gone', async () => {
      (await ctx.client.as(person).del('/v1/account/delete-immediately')).status(200).body().has('$.success', true);
      const left = await accountRows(ctx, [first, second]);
      if (left !== 0) throw new Error(`${left} of the person's accounts survived`);
    });
    await ctx.step('the login is gone: the password grant → 400, the old token → 401', async () => {
      const status = await passwordGrantStatus(ctx, person);
      if (status !== 400) throw new Error(`password grant after the deletion → ${status}`);
      (await ctx.client.as(person).get('/v1/accounts/me')).status(401);
    });
  },
);

flow(
  'DEL-8',
  {
    domain: 'accounts',
    requires: ['database'],
    routes: [
      'GET /v1/account/deletion-plan',
      'DELETE /v1/account/delete-immediately',
      'POST /v1/account/request-deletion',
      'POST /v1/account/cancel-deletion',
      'GET /v1/account/deletion-status',
      'POST /v1/accounts/:accountId/members',
      'PATCH /v1/accounts/:accountId/members/:userId',
    ],
  },
  async (ctx) => {
    const owner = await ctx.fixtures.user({ label: 'DEL-8-OWNER' });
    const member = await ctx.fixtures.user({ label: 'DEL-8-MEMBER', noAccount: true });
    const shared = owner.accountId!;
    const asOwner = ctx.client.as(owner);

    await ctx.step('the sole owner of a workspace with a member is refused, now and scheduled → 409 with the list; nothing is deleted', async () => {
      (await asOwner.post('/v1/accounts/:accountId/members', { email: member.email, role: 'member' }, { params: { accountId: shared } })).status(201);
      for (const call of [() => asOwner.del('/v1/account/delete-immediately'), () => asOwner.post('/v1/account/request-deletion', {})]) {
        const r = await call();
        r.status(409).body().has('$.code', 'sole_owner_of_shared_workspace').has('$.workspaces[0].workspace_id', shared).has('$.workspaces[0].member_count', 2);
      }
      if ((await accountRows(ctx, [shared])) !== 1) throw new Error('the shared workspace was deleted');
      if ((await passwordGrantStatus(ctx, owner)) !== 200) throw new Error('the refused person lost their login');
    });
    await ctx.step('after the member becomes an owner, the person leaves instead → 200; the workspace stays for the member', async () => {
      (await asOwner.patch('/v1/accounts/:accountId/members/:userId', { role: 'owner' }, { params: { accountId: shared, userId: member.userId! } }))
        .status(200);
      const plan = (await asOwner.get('/v1/account/deletion-plan')).status(200).json<{ leave_workspaces: string[]; blockers: unknown[] }>();
      if (plan.leave_workspaces.join() !== shared || plan.blockers.length) throw new Error(`plan ${JSON.stringify(plan)}`);
      (await asOwner.del('/v1/account/delete-immediately')).status(200).body().has('$.leave_workspaces', [shared]);
      if ((await accountRows(ctx, [shared])) !== 1) throw new Error('the shared workspace was deleted with the person who left');
      (await ctx.client.as(member).get('/v1/accounts/:accountId', { params: { accountId: shared } })).status(200);
      if ((await passwordGrantStatus(ctx, owner)) !== 400) throw new Error('the login survived the deletion');
    });
    await ctx.step('the scheduled path: request → pending 14 days out; cancel → nothing pending; the workspace is untouched', async () => {
      const solo = await ctx.fixtures.user({ label: 'DEL-8-SOLO' });
      const r = await ctx.client.as(solo).post('/v1/account/request-deletion', {});
      r.status(200).body().has('$.success', true).has('$.plan.delete_workspaces', [solo.accountId!]);
      const when = Date.parse(r.json<{ deletion_scheduled_for: string }>().deletion_scheduled_for);
      if (!(Math.abs(when - (Date.now() + 14 * DAY_MS)) < DAY_MS)) throw new Error(`deletion_scheduled_for ${new Date(when).toISOString()}`);
      // The request ended the person's sign-ins: a fresh sign-in cancels.
      const fresh = await fetch(`${ctx.env.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ctx.env.supabaseAnonKey!, 'content-type': 'application/json' },
        body: JSON.stringify({ email: solo.email, password: PASSWORD }),
      });
      if (fresh.status !== 200) throw new Error(`sign-in during the grace → ${fresh.status}`);
      const token = ((await fresh.json()) as { access_token: string }).access_token;
      const asFresh = ctx.client.withBearer(token, 'DEL-8-SOLO-fresh');
      (await asFresh.get('/v1/account/deletion-status')).status(200).body().has('$.has_pending_deletion', true).has('$.can_cancel', true);
      (await asFresh.post('/v1/account/cancel-deletion', {})).status(200).body().has('$.success', true);
      (await asFresh.get('/v1/account/deletion-status')).status(200).body().has('$.has_pending_deletion', false);
      if ((await accountRows(ctx, [solo.accountId!])) !== 1) throw new Error('the cancelled deletion removed the workspace');
    });
  },
);
