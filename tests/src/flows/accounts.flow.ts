/**
 * Accounts & identity — authenticated. Maps to spec §4 (ME-*, ACCT-*, MEM-*, TOK-*).
 * Needs OWNER + NONMEMBER principals (provisioned per run).
 */
import { flow } from '../core/flow';

flow(
  'ME-1',
  { domain: 'accounts', tags: ['smoke'], routes: ['GET /v1/accounts/me'] },
  async (ctx) => {
    await ctx.step('OWNER sees own identity', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/me');
      r.status(200).body().exists('$.user_id').exists('$.email');
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/accounts/me');
      r.status(401);
    });
  },
);

flow('ACCT-1', { domain: 'accounts', routes: ['GET /v1/accounts'] }, async (ctx) => {
  await ctx.step('list memberships', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts');
    r.status(200);
  });
});

flow(
  'ACCT-2',
  { domain: 'accounts', routes: ['POST /v1/accounts', 'GET /v1/accounts/:accountId'] },
  async (ctx) => {
    let accountId = '';
    await ctx.step('create team account → caller is owner', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/accounts', { name: ctx.fixtures.name('team') });
      r.status(201).body().has('$.is_primary_owner', true).has('$.account_role', 'owner');
      accountId = r.json<any>().account_id;
      ctx.track('account', accountId);
    });
    await ctx.step('owner can read it', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId', { params: { accountId } });
      r.status(200).body().has('$.account_id', accountId);
    });
    await ctx.step('NONMEMBER cannot read it → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/accounts/:accountId', { params: { accountId } });
      r.status(403);
    });
  },
);

flow(
  'TOK-1',
  {
    domain: 'accounts',
    routes: [
      'POST /v1/accounts/tokens',
      'GET /v1/accounts/tokens',
      'DELETE /v1/accounts/tokens/:tokenId',
    ],
    serial: true,
  },
  async (ctx) => {
    let tokenId = '';
    await ctx.step('mint PAT → secret returned once', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/accounts/tokens', { name: ctx.fixtures.name('tok') });
      r.status(201).body().exists('$.secret_key').exists('$.token_id');
      tokenId = r.json<any>().token_id;
    });
    await ctx.step('list does not expose the secret', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/tokens');
      r.status(200);
    });
    await ctx.step('revoke it', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/accounts/tokens/:tokenId', { params: { tokenId } });
      r.status(200).body().has('$.ok', true);
    });
  },
);

flow('TOK-2', { domain: 'accounts', routes: ['POST /v1/accounts/tokens'] }, async (ctx) => {
  await ctx.step('missing name → 400', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/tokens', {});
    r.status(400);
  });
});

flow('ACCT-4', { domain: 'accounts', routes: ['PATCH /v1/accounts/:accountId'] }, async (ctx) => {
  const team = await ctx.fixtures.team();
  await ctx.step('OWNER renames account', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .patch(
        '/v1/accounts/:accountId',
        { name: ctx.fixtures.name('renamed') },
        { params: { accountId: team.id } },
      );
    r.status(200);
  });
  await ctx.step('MEMBER cannot rename → 403', async () => {
    const member = await team.addMember('member');
    const r = await ctx.client
      .as(member)
      .patch('/v1/accounts/:accountId', { name: 'nope' }, { params: { accountId: team.id } });
    r.status(403);
  });
});

flow(
  'MEM-1',
  {
    domain: 'accounts',
    routes: ['GET /v1/accounts/:accountId/members', 'POST /v1/accounts/:accountId/members'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step('add an admin member → 201 status added', async () => {
      await team.addMember('admin');
    });
    await ctx.step('list members → owner + admin present', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/members', { params: { accountId: team.id } });
      r.status(200);
    });
    await ctx.step('NONMEMBER cannot list → 403', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/accounts/:accountId/members', { params: { accountId: team.id } });
      r.status(403);
    });
    await ctx.step(
      "plain MEMBER sees the directory, with other members' sensitive columns redacted",
      async () => {
        const memberA = await team.addMember('member');
        const memberB = await team.addMember('member');
        const r = await ctx.client
          .as(memberA)
          .get('/v1/accounts/:accountId/members', { params: { accountId: team.id } });
        r.status(200);
        const list = r.json<any[]>();
        if (!list.some((m) => m.user_id === memberA.userId))
          throw new Error('member cannot see their own row');
        if (!list.some((m) => m.user_id === memberB.userId))
          throw new Error('member directory omitted a teammate');
        for (const m of list) {
          if (m.user_id === memberA.userId) continue;
          if (m.active_pat_count !== 0 || m.has_verified_mfa !== false || m.groups.length !== 0)
            throw new Error('sensitive member columns leaked to plain member');
        }
      },
    );
  },
);

flow(
  'MEM-2',
  { domain: 'accounts', routes: ['POST /v1/accounts/:accountId/members'] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    await ctx.step('inviting an existing member again → 409', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/accounts/:accountId/members',
          { email: member.email, role: 'member' },
          { params: { accountId: team.id } },
        );
      r.status(409);
    });
    await ctx.step('MEMBER cannot invite → 403', async () => {
      const r = await ctx.client
        .as(member)
        .post(
          '/v1/accounts/:accountId/members',
          { email: 'x@ke2e.kortix.test', role: 'member' },
          { params: { accountId: team.id } },
        );
      r.status(403);
    });
  },
);

flow(
  'MEM-3',
  { domain: 'accounts', routes: ['PATCH /v1/accounts/:accountId/members/:userId'] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    await ctx.step('OWNER promotes member → admin', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/members/:userId',
          { role: 'admin' },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(200);
    });
    await ctx.step('invalid role → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/members/:userId',
          { role: 'wizard' },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(400);
    });
  },
);

flow(
  'MEM-4',
  { domain: 'accounts', routes: ['DELETE /v1/accounts/:accountId/members/:userId'] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    await ctx.step('OWNER removes member → ok', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/members/:userId', {
        params: { accountId: team.id, userId: member.userId! },
      });
      r.status(200).body().has('$.ok', true);
    });
  },
);

flow(
  'MEM-5',
  { domain: 'accounts', routes: ['POST /v1/accounts/:accountId/leave'] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    await ctx.step('member leaves → ok', async () => {
      const r = await ctx.client
        .as(member)
        .post('/v1/accounts/:accountId/leave', {}, { params: { accountId: team.id } });
      r.status(200);
    });
    await ctx.step('non-member leave → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post('/v1/accounts/:accountId/leave', {}, { params: { accountId: team.id } });
      r.status(404);
    });
  },
);

flow(
  'INV-1',
  { domain: 'accounts', routes: ['GET /v1/accounts/:accountId/invites'] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step('list pending invites', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/accounts/:accountId/invites', { params: { accountId: team.id } });
      r.status(200);
    });
    await ctx.step('plain MEMBER sees no pending invites', async () => {
      const member = await team.addMember('member');
      const r = await ctx.client
        .as(member)
        .get('/v1/accounts/:accountId/invites', { params: { accountId: team.id } });
      r.status(200);
      if (r.json<any[]>().length !== 0) throw new Error('pending invites leaked to plain member');
    });
  },
);

flow(
  'DEL-1',
  { domain: 'accounts', routes: ['GET /v1/billing/account/deletion-status'] },
  async (ctx) => {
    await ctx.step('OWNER reads deletion status', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/billing/account/deletion-status');
      r.status(200);
    });
  },
);

// DEL-3 — the "backwards-compatible" `/v1/account/*` deletion mount
// (apps/api/src/billing/routes/account-deletion.ts, mounted at /v1/account/*
// in apps/api/src/index.ts:694, distinct from the `/v1/billing/account/*`
// mirror mount covered by DEL-1/DEL-2). Drives `GET .../deletion-status` and
// the real, destructive `DELETE .../delete-immediately` on a THROWAWAY user's
// own personal account (never OWNER/team accounts other flows depend on).
// deleteAccountImmediately() zeroes the credit account (balance/tier/status)
// but does not remove the Supabase auth identity — the world fixture tears
// that down via the admin API regardless of what this flow does to it.
flow(
  'DEL-4',
  {
    domain: 'accounts',
    routes: ['DELETE /v1/account/delete-immediately', 'GET /v1/account/deletion-status'],
  },
  async (ctx) => {
    const victim = await ctx.fixtures.user({ label: 'DEL-4' });
    const asVictim = ctx.client.as(victim);

    await ctx.step('ANON cannot read deletion status → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/account/deletion-status');
      r.status(401);
    });
    await ctx.step('ANON cannot delete-immediately → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).del('/v1/account/delete-immediately');
      r.status(401);
    });
    await ctx.step('fresh throwaway account has no pending deletion', async () => {
      const r = await asVictim.get('/v1/account/deletion-status');
      r.status(200)
        .body()
        .has('$.has_pending_deletion', false)
        .has('$.deletion_scheduled_for', null)
        .has('$.can_cancel', false);
    });
    await ctx.step('throwaway account deletes itself immediately → 200', async () => {
      const r = await asVictim.del('/v1/account/delete-immediately');
      r.status(200).body().has('$.success', true).has('$.message', 'Account deleted');
    });
    await ctx.step('deletion-status is still readable after immediate delete', async () => {
      // No deletion REQUEST was ever scheduled, so the immediate delete doesn't
      // flip has_pending_deletion — it just proves the account (and its token)
      // are still usable, i.e. delete-immediately zeroes credits rather than
      // hard-deleting the identity.
      const r = await asVictim.get('/v1/account/deletion-status');
      r.status(200).body().has('$.has_pending_deletion', false);
    });
    await ctx.step('delete-immediately is idempotent → 200 again', async () => {
      const r = await asVictim.del('/v1/account/delete-immediately');
      r.status(200).body().has('$.success', true);
    });
  },
);

// ACCT-3 — GET a single account: a member reads it (200, with role + counts);
// a NONMEMBER is forbidden (403).
flow('ACCT-3', { domain: 'accounts', routes: ['GET /v1/accounts/:accountId'] }, async (ctx) => {
  const team = await ctx.fixtures.team();
  await ctx.step('OWNER (member) reads the account → 200', async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get('/v1/accounts/:accountId', { params: { accountId: team.id } });
    r.status(200).body().has('$.account_id', team.id).exists('$.role').exists('$.member_count');
  });
  await ctx.step('NONMEMBER → 403', async () => {
    const r = await ctx.client
      .as(ctx.P.NONMEMBER)
      .get('/v1/accounts/:accountId', { params: { accountId: team.id } });
    r.status(403);
  });
});

// TOK-3 — account-PAT revoke semantics: revoke → 200; unknown/already-revoked
// → 404; a revoked secret used on any route → 401.
flow(
  'TOK-3',
  {
    domain: 'accounts',
    serial: true,
    routes: [
      'POST /v1/accounts/tokens',
      'DELETE /v1/accounts/tokens/:tokenId',
      'GET /v1/accounts/me',
    ],
  },
  async (ctx) => {
    let tokenId = '';
    let secret = '';
    await ctx.step('mint an account PAT', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/accounts/tokens', { name: ctx.fixtures.name('revoke') });
      r.status(201).body().exists('$.secret_key').exists('$.token_id');
      const j = r.json<any>();
      tokenId = j.token_id;
      secret = j.secret_key;
    });
    await ctx.step('secret authenticates before revoke → 200', async () => {
      const r = await ctx.client.withBearer(secret).get('/v1/accounts/me');
      r.status(200);
    });
    await ctx.step('revoke → 200 {ok:true}', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/accounts/tokens/:tokenId', { params: { tokenId } });
      r.status(200).body().has('$.ok', true);
    });
    await ctx.step('revoke again (already revoked) → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/accounts/tokens/:tokenId', { params: { tokenId } });
      r.status(404);
    });
    await ctx.step('revoke an unknown id → 404', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/tokens/:tokenId', {
        params: { tokenId: '00000000-0000-0000-0000-000000000000' },
      });
      r.status(404);
    });
    await ctx.step('revoked secret on any route → 401', async () => {
      const r = await ctx.client.withBearer(secret).get('/v1/accounts/me');
      r.status(401);
    });
  },
);

// TOK-4 — project-scoped PAT (enforceTokenProjectScope): allowed only on its
// own project + the `/accounts/me` self-identity probe; every other surface
// (a different project, project-list, account-level routes) → 403.
flow(
  'TOK-4',
  {
    domain: 'accounts',
    routes: [
      'POST /v1/projects/:projectId/cli-token',
      'DELETE /v1/projects/:projectId/cli-token/:tokenId',
      'GET /v1/projects/:projectId',
      'GET /v1/projects/:projectId/secrets',
      'GET /v1/projects',
      'GET /v1/accounts/me',
      'GET /v1/accounts/tokens',
    ],
  },
  async (ctx) => {
    const projA = await ctx.fixtures.project();
    const projB = await ctx.fixtures.project();
    let secret = '';
    let tokenId = '';
    await ctx.step('mint a project-scoped PAT on project A', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/cli-token',
          { name: ctx.fixtures.name('proj-pat') },
          { params: { projectId: projA.id } },
        );
      r.status(201).body().exists('$.secret_key').has('$.project_id', projA.id);
      const j = r.json<any>();
      secret = j.secret_key;
      tokenId = j.token_id;
    });
    const pat = () => ctx.client.withBearer(secret, 'PAT_PROJ');
    await ctx.step('allowed: GET its own project → 200', async () => {
      const r = await pat().get('/v1/projects/:projectId', { params: { projectId: projA.id } });
      r.status(200);
    });
    await ctx.step("allowed: GET its own project's secrets → 200", async () => {
      const r = await pat().get('/v1/projects/:projectId/secrets', {
        params: { projectId: projA.id },
      });
      r.status(200);
    });
    await ctx.step('allowed: self-identity probe /accounts/me → 200', async () => {
      const r = await pat().get('/v1/accounts/me');
      r.status(200);
    });
    await ctx.step('denied: a different project → 403', async () => {
      const r = await pat().get('/v1/projects/:projectId', { params: { projectId: projB.id } });
      r.status(403);
    });
    await ctx.step('denied: enumerate projects → 403', async () => {
      const r = await pat().get('/v1/projects');
      r.status(403);
    });
    await ctx.step('denied: account-level route → 403', async () => {
      const r = await pat().get('/v1/accounts/tokens');
      r.status(403);
    });
    await ctx.step('revoke the project token → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/cli-token/:tokenId', {
        params: { projectId: projA.id, tokenId },
      });
      r.status(200).body().has('$.ok', true);
    });
  },
);

// TOK-5 — project-scoped PAT cross-project WRITE boundary. TOK-4 proves a
// project PAT can't READ a foreign project; this proves it can't MUTATE one
// either (POST secrets, POST triggers, DELETE secrets on a different project →
// 403). enforceTokenProjectScope (apps/api/src/middleware/auth.ts:702-711)
// rejects any /v1/projects/:projectId/* where the URL id ≠ the token's project
// at the auth layer, BEFORE the route handler's loadProjectForUser — so a
// scope regression that only checked reads (or skipped writes) would let a
// project PAT mutate another project. The positive path (write on its own
// project → 200) proves the 403 is the scope gate, not a body/authz-floor fail.
flow(
  'TOK-5',
  {
    domain: 'accounts',
    serial: true,
    routes: [
      'POST /v1/projects/:projectId/cli-token',
      'DELETE /v1/projects/:projectId/cli-token/:tokenId',
      'POST /v1/projects/:projectId/secrets',
      'DELETE /v1/projects/:projectId/secrets/:name',
      'POST /v1/projects/:projectId/triggers',
    ],
  },
  async (ctx) => {
    const projA = await ctx.fixtures.project();
    const projB = await ctx.fixtures.project();
    let secret = '';
    let tokenId = '';
    await ctx.step('mint a project-scoped PAT on project A', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/cli-token',
          { name: ctx.fixtures.name('proj-pat-write') },
          { params: { projectId: projA.id } },
        );
      r.status(201).body().exists('$.secret_key').has('$.project_id', projA.id);
      const j = r.json<any>();
      secret = j.secret_key;
      tokenId = j.token_id;
    });
    const pat = () => ctx.client.withBearer(secret, 'PAT_PROJ');

    // ── Positive path: the PAT CAN write on its OWN project (proves the
    //    denials below are the scope gate, not a malformed body / authz floor).
    await ctx.step('allowed: POST a secret on its OWN project → 200', async () => {
      const r = await pat().post(
        '/v1/projects/:projectId/secrets',
        { name: 'MY_KEY', value: 'val' },
        { params: { projectId: projA.id } },
      );
      r.status(200);
    });
    await ctx.step('allowed: POST a trigger on its OWN project → 201', async () => {
      const r = await pat().post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Own Trigger',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
        },
        { params: { projectId: projA.id } },
      );
      r.status(201);
    });

    // ── Cross-project WRITE denials: every foreign-project mutation → 403
    //    (enforceTokenProjectScope fires at the auth layer, before the handler).
    await ctx.step('denied: POST a secret on a FOREIGN project → 403', async () => {
      const r = await pat().post(
        '/v1/projects/:projectId/secrets',
        { name: 'FOREIGN_KEY', value: 'val' },
        { params: { projectId: projB.id } },
      );
      r.status(403);
    });
    await ctx.step('denied: POST a trigger on a FOREIGN project → 403', async () => {
      const r = await pat().post(
        '/v1/projects/:projectId/triggers',
        {
          name: 'Foreign Trigger',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'x',
        },
        { params: { projectId: projB.id } },
      );
      r.status(403);
    });
    await ctx.step('denied: DELETE a secret on a FOREIGN project → 403', async () => {
      const r = await pat().del('/v1/projects/:projectId/secrets/:name', {
        params: { projectId: projB.id, name: 'ANY_KEY' },
      });
      r.status(403);
    });

    await ctx.step('revoke the project token → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/projects/:projectId/cli-token/:tokenId', {
        params: { projectId: projA.id, tokenId },
      });
      r.status(200).body().has('$.ok', true);
    });
  },
);
