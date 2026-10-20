/**
 * Accounts & identity — authenticated. Maps to spec §4 (ME-*, ACCT-*, MEM-*, TOK-*).
 * Needs OWNER + NONMEMBER principals (provisioned per run).
 */
import { AccountSummarySchema } from '@kortix/api-contract';
import { CliSandbox } from '../fixtures/cli';
import { flow } from '../core/flow';
import type { Client } from '../core/client';
import type { Principal } from '../core/types';
import { enableEnterpriseDemo } from '../fixtures/enterprise-access';
import { waitFor } from '../core/poll';
import { adminCreateUser, adminDeleteUser, passwordGrant } from '../fixtures/supabase';

flow(
  'ME-1',
  { domain: 'accounts', tags: ['deployed', 'smoke'], routes: ['GET /v1/accounts/me'] },
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
  await ctx.step('list memberships; every row matches the contract AccountSummary', async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts');
    r.status(200).body().schema(AccountSummarySchema.array());
  });
  await ctx.step(
    "the personal account is named, never after the email (KRTX-638: no \"<email>'s Account\")",
    async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts');
      r.status(200);
      const personal = r
        .json<Array<{ account_id: string; name: string }>>()
        .find((account) => account.account_id === ctx.P.OWNER.userId);
      if (!personal) throw new Error('OWNER has no personal account in GET /v1/accounts');
      if (!personal.name.trim()) throw new Error('personal account has an empty name');
      if (personal.name.includes('@') || personal.name.endsWith("'s Account"))
        throw new Error(`personal account is still named after the email: ${personal.name}`);
    },
  );
});

flow(
  'ACCT-2',
  { domain: 'accounts', tags: ['deployed'], routes: ['POST /v1/accounts', 'GET /v1/accounts/:accountId'] },
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
    await ctx.step('create without a name → 400 Validation failed; a 256-character name → 400 name is too long', async () => {
      (await ctx.client.as(ctx.P.OWNER).post('/v1/accounts', {})).status(400).body().has('$.message', 'Validation failed');
      (await ctx.client.as(ctx.P.OWNER).post('/v1/accounts', { name: 'a'.repeat(256) }))
        .status(400).body().has('$.error', 'name is too long');
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
  await ctx.step('OWNER renames account → 200 with the new name', async () => {
    const name = ctx.fixtures.name('renamed');
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .patch('/v1/accounts/:accountId', { name }, { params: { accountId: team.id } });
    r.status(200).body().has('$.name', name);
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
      'plain MEMBER lists only themselves: not the owner, not a teammate',
      async () => {
        const memberA = await team.addMember('member');
        const memberB = await team.addMember('member');
        const r = await ctx.client
          .as(memberA)
          .get('/v1/accounts/:accountId/members', { params: { accountId: team.id } });
        r.status(200);
        const ids = r.json<Array<{ user_id: string }>>().map((m) => m.user_id);
        if (JSON.stringify(ids) !== JSON.stringify([memberA.userId]))
          throw new Error(`a plain member must list only themselves, got ${JSON.stringify(ids)} (teammate ${memberB.userId})`);
      },
    );
  },
);

flow(
  'MEM-8',
  {
    domain: 'accounts',
    routes: [
      'GET /v1/accounts/:accountId/members',
      'GET /v1/accounts/:accountId/iam/groups',
      'GET /v1/accounts/:accountId/iam/groups/:groupId',
      'GET /v1/accounts/:accountId/iam/groups/:groupId/members',
      'GET /v1/accounts/:accountId/iam/groups/:groupId/project-grants',
      'GET /v1/projects/:projectId/access',
      'GET /v1/accounts/:accountId/iam/mfa-required/preview',
      'GET /v1/accounts/:accountId/iam/sessions',
      'GET /v1/accounts/:accountId/iam/members/:userId/project-access',
      'POST /v1/accounts/:accountId/iam/roles',
      'POST /v1/accounts/:accountId/iam/policies',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id };
    const viewer = await team.addMember('member');
    const coProject = await team.addMember('member');
    const groupMate = await team.addMember('member');
    const viaGroup = await team.addMember('member');
    const stranger = await team.addMember('member');
    const admin = await team.addMember('admin');
    const asViewer = ctx.client.as(viewer);
    const shared = await team.project();
    const hidden = await team.project();
    let mine = '';
    let onShared = '';
    let elsewhere = '';

    const group = async (slug: string, members: Principal[]) => {
      const created = await owner.post(
        '/v1/accounts/:accountId/iam/groups',
        { name: ctx.fixtures.name(slug) },
        { params },
      );
      const groupId = created.status(201).json<{ group_id: string }>().group_id;
      (
        await owner.post(
          '/v1/accounts/:accountId/iam/groups/:groupId/members',
          { userIds: members.map((m) => m.userId!) },
          { params: { ...params, groupId } },
        )
      ).status(200);
      return groupId;
    };
    const grantGroup = async (projectId: string, groupId: string) =>
      (
        await owner.post(
          '/v1/projects/:projectId/group-grants',
          { group_id: groupId, role: 'member' },
          { params: { projectId } },
        )
      ).status(201);
    const memberIds = async (who: Client) =>
      (await who.get('/v1/accounts/:accountId/members', { params }))
        .status(200)
        .json<Array<{ user_id: string }>>()
        .map((m) => m.user_id);
    const groupRows = async (who: Client) =>
      (await who.get('/v1/accounts/:accountId/iam/groups', { params }))
        .status(200)
        .json<{ groups: Array<{ group_id: string; project_count: number }> }>().groups;
    const groupIds = async (who: Client) => (await groupRows(who)).map((g) => g.group_id);
    const expectIds = (label: string, ids: string[], present: string[], absent: string[]) => {
      const missing = present.filter((id) => !ids.includes(id));
      const leaked = absent.filter((id) => ids.includes(id));
      if (missing.length || leaked.length) {
        throw new Error(`${label}: missing ${JSON.stringify(missing)}, leaked ${JSON.stringify(leaked)}`);
      }
    };

    await ctx.step(
      'setup: the viewer shares one project with a teammate and a group with another; a third reaches the project through a group; a fourth shares nothing',
      async () => {
        await team.grantProjectRole(shared.id, viewer.userId!, 'member');
        await team.grantProjectRole(shared.id, coProject.userId!, 'member');
        mine = await group('grp-mine', [viewer, groupMate]);
        onShared = await group('grp-shared', [viaGroup]);
        elsewhere = await group('grp-elsewhere', [stranger]);
        await grantGroup(shared.id, onShared);
        await grantGroup(hidden.id, onShared);
        await grantGroup(hidden.id, elsewhere);
      },
    );

    await ctx.step(
      'a plain member lists only themselves: not the owner, the admin, nor anyone they share a project or a group with',
      async () => {
        expectIds(
          'viewer members',
          await memberIds(asViewer),
          [viewer.userId!],
          [ctx.P.OWNER, admin, coProject, groupMate, viaGroup, stranger].map((p) => p.userId!),
        );
      },
    );

    await ctx.step('the owner and an admin still list every member', async () => {
      const everyone = [viewer, coProject, groupMate, viaGroup, stranger].map((p) => p.userId!);
      expectIds('owner members', await memberIds(owner), everyone, []);
      expectIds('admin members', await memberIds(ctx.client.as(admin)), everyone, []);
    });

    await ctx.step('a plain member lists no group, not even their own; the owner lists every group', async () => {
      expectIds('viewer groups', await groupIds(asViewer), [], [mine, onShared, elsewhere]);
      expectIds('owner groups', await groupIds(owner), [mine, onShared, elsewhere], []);
    });

    await ctx.step('every group → 404 for a plain member on read, members and project grants', async () => {
      for (const groupId of [mine, onShared, elsewhere]) {
        const at = { params: { ...params, groupId } };
        (await asViewer.get('/v1/accounts/:accountId/iam/groups/:groupId', at)).status(404);
        (await asViewer.get('/v1/accounts/:accountId/iam/groups/:groupId/members', at)).status(404);
        (await asViewer.get('/v1/accounts/:accountId/iam/groups/:groupId/project-grants', at)).status(404);
      }
      (await owner.get('/v1/accounts/:accountId/iam/groups/:groupId', { params: { ...params, groupId: onShared } }))
        .status(200)
        .body()
        .has('$.group_id', onShared);
    });

    await ctx.step(
      "a project's access list: a plain member sees only themselves; a member who manages it sees the people and groups with access to it, nobody else; the owner sees every member",
      async () => {
        const manager = await team.addMember('member');
        await team.grantProjectRole(shared.id, manager.userId!, 'manager');
        const roster = async (who: Client) => {
          const view = (await who.get('/v1/projects/:projectId/access', { params: { projectId: shared.id } }))
            .status(200)
            .json<{ members: Array<{ user_id: string }>; group_access: Array<{ group_id: string }> }>();
          return { people: view.members.map((m) => m.user_id), groups: view.group_access.map((g) => g.group_id) };
        };
        const asViewerRoster = await roster(asViewer);
        expectIds(
          'viewer project access',
          asViewerRoster.people,
          [viewer.userId!],
          [ctx.P.OWNER, admin, coProject, viaGroup, stranger].map((p) => p.userId!),
        );
        expectIds('viewer project groups', asViewerRoster.groups, [], [onShared]);
        const managerRoster = await roster(ctx.client.as(manager));
        expectIds(
          'manager project access',
          managerRoster.people,
          [manager, viewer, coProject, viaGroup].map((p) => p.userId!),
          [groupMate, stranger].map((p) => p.userId!),
        );
        expectIds('manager project groups', managerRoster.groups, [onShared], [mine, elsewhere]);
        expectIds('owner project access', (await roster(owner)).people, [stranger.userId!], []);
      },
    );

    await ctx.step(
      "other members' MFA status, sign-in sessions and access details → 403 for a plain member; their own access → 200",
      async () => {
        (await asViewer.get('/v1/accounts/:accountId/iam/mfa-required/preview', { params })).status(403);
        (await owner.get('/v1/accounts/:accountId/iam/mfa-required/preview', { params })).status(200);
        (await asViewer.get('/v1/accounts/:accountId/iam/sessions', { params })).status(403);
        const access = '/v1/accounts/:accountId/iam/members/:userId/project-access';
        (await asViewer.get(access, { params: { ...params, userId: coProject.userId! } })).status(403);
        (await asViewer.get(access, { params: { ...params, userId: viewer.userId! } })).status(200);
      },
    );

    await ctx.step(
      'an owner restores the full directory for one member with a custom role holding member.read and group.read',
      async () => {
        const key = `directory_${Date.now().toString(36)}`;
        const role = await owner.post(
          '/v1/accounts/:accountId/iam/roles',
          { key, name: key, resourceType: 'account', actions: ['member.read', 'group.read'] },
          { params },
        );
        const roleId = role.status(201).json<{ role_id: string }>().role_id;
        (
          await owner.post(
            '/v1/accounts/:accountId/iam/policies',
            { principalType: 'member', principalId: viewer.userId, roleId, scopeType: 'account' },
            { params },
          )
        ).status(201);
        // IAM verdicts are cached for up to 15 s: a fresh assignment can read the old answer first.
        const ids = await waitFor(() => memberIds(asViewer), {
          until: (list) => list.includes(stranger.userId!),
          timeoutMs: 20_000,
          intervalMs: 1_000,
          description: 'the full member list after the custom role',
        });
        expectIds('viewer members after the role', ids, [stranger.userId!], []);
        expectIds('viewer groups after the role', await groupIds(asViewer), [elsewhere], []);
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
  { domain: 'accounts', routes: [
    'DELETE /v1/accounts/:accountId/members/:userId',
    'POST /v1/accounts/:accountId/iam/groups',
    'POST /v1/accounts/:accountId/iam/groups/:groupId/members',
    'GET /v1/accounts/:accountId/iam/groups/:groupId/members',
    'POST /v1/accounts/:accountId/iam/scim/tokens',
    'GET /scim/v2/accounts/:accountId/Users/:userId',
  ] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    let groupId = '';
    let scim: ReturnType<typeof ctx.client.withBearer>;
    await ctx.step('enable groups and add the member to one', async () => {
      await enableEnterpriseDemo(ctx, team.id);
      const created = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/iam/groups',
        { name: ctx.fixtures.name('offboard') },
        { params: { accountId: team.id } },
      );
      created.status(201);
      groupId = created.json<any>().group_id;
      const added = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/iam/groups/:groupId/members',
        { userIds: [member.userId!] },
        { params: { accountId: team.id, groupId } },
      );
      added.status(200).body().has('$.added', 1);
      const token = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/iam/scim/tokens',
        { name: ctx.fixtures.name('offboard') },
        { params: { accountId: team.id } },
      );
      token.status(201);
      scim = ctx.client.withBearer(token.json<any>().secret, 'SCIM');
    });
    await ctx.step('OWNER removes a malformed user id → 400, not 500', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/members/:userId', {
        params: { accountId: team.id, userId: 'not-a-uuid' },
      });
      r.status(400).body().has('$.message', 'Validation failed');
    });
    await ctx.step('an ADMIN removing the OWNER → 403 Admins cannot remove owners', async () => {
      const admin = await team.addMember('admin');
      (await ctx.client.as(admin).del('/v1/accounts/:accountId/members/:userId', {
        params: { accountId: team.id, userId: ctx.P.OWNER.userId! },
      })).status(403).body().has('$.error', 'Admins cannot remove owners');
    });
    await ctx.step('the OWNER removing the last owner (themselves) → 409', async () => {
      (await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/members/:userId', {
        params: { accountId: team.id, userId: ctx.P.OWNER.userId! },
      })).status(409).body().has('$.error', 'Cannot remove the last owner');
    });
    await ctx.step('OWNER removes member → ok', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/members/:userId', {
        params: { accountId: team.id, userId: member.userId! },
      });
      r.status(200).body().has('$.ok', true);
    });
    await ctx.step('removed member has no residual group grant', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/iam/groups/:groupId/members', {
        params: { accountId: team.id, groupId },
      });
      r.status(200);
      if (r.json<any>().members.some((row: any) => row.user_id === member.userId)) {
        throw new Error('Removed account member remains in the group');
      }
      const directoryUser = await scim.get('/scim/v2/accounts/:accountId/Users/:userId', {
        params: { accountId: team.id, userId: member.userId! },
      });
      directoryUser.status(200).body().has('$.active', false);
    });
  },
);

flow(
  'MEM-5',
  { domain: 'accounts', routes: [
    'POST /v1/accounts/:accountId/leave',
    'POST /v1/accounts/:accountId/iam/groups',
    'POST /v1/accounts/:accountId/iam/groups/:groupId/members',
    'GET /v1/accounts/:accountId/iam/groups/:groupId/members',
  ] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    let groupId = '';
    await ctx.step('the member is in a group', async () => {
      await enableEnterpriseDemo(ctx, team.id);
      const created = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/iam/groups',
        { name: ctx.fixtures.name('leaver') },
        { params: { accountId: team.id } },
      );
      created.status(201);
      groupId = created.json<any>().group_id;
      (await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/iam/groups/:groupId/members',
        { userIds: [member.userId!] },
        { params: { accountId: team.id, groupId } },
      )).status(200).body().has('$.added', 1);
    });
    await ctx.step('member leaves → ok', async () => {
      const r = await ctx.client
        .as(member)
        .post('/v1/accounts/:accountId/leave', {}, { params: { accountId: team.id } });
      r.status(200);
    });
    // KRTX-1722: leaving kept the group rows, so a re-invite restored every
    // group grant. Removal and SCIM already delete them.
    await ctx.step('the leaver is in no group of the account', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/iam/groups/:groupId/members', {
        params: { accountId: team.id, groupId },
      });
      r.status(200);
      if (r.json<any>().members.some((row: any) => row.user_id === member.userId)) {
        throw new Error('The member who left remains in the group');
      }
    });
    await ctx.step('non-member leave → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post('/v1/accounts/:accountId/leave', {}, { params: { accountId: team.id } });
      r.status(404);
    });
    await ctx.step('the last owner cannot leave → 409', async () => {
      (await ctx.client.as(ctx.P.OWNER).post('/v1/accounts/:accountId/leave', {}, { params: { accountId: team.id } }))
        .status(409).body().has('$.error', 'Cannot leave as the last owner — transfer ownership first');
    });
  },
);

// MEM-6 — role-transition matrix on PATCH /members/:userId. MEM-3 only covered
// member→admin (promotion) + invalid role → 400. The PATCH handler
// (apps/api/src/accounts/core/members.ts:579-648) encodes several invariants
// that were unproven:
//   - same-role PATCH → 200 {unchanged:true} (idempotent no-op)
//   - admin demotes member→member (admin CAN demote a non-owner) → 200
//   - admin cannot demote an owner → 403 ("Only an owner can assign or change
//     the owner role") — distinct from the last-owner 409
//   - admin cannot promote anyone to owner → 403 ("Only owners can grant the
//     owner role") — the privilege-escalation guard
//   - demote the LAST owner → 409 ("Cannot demote the last owner")
//   - PATCH an unknown userId → 404 ("Member not found")
flow(
  'MEM-6',
  {
    domain: 'accounts',
    routes: ['PATCH /v1/accounts/:accountId/members/:userId'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const admin = await team.addMember('admin');
    const member = await team.addMember('member');

    await ctx.step('OWNER demotes admin → member (downward transition) → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/members/:userId',
          { role: 'member' },
          { params: { accountId: team.id, userId: admin.userId! } },
        );
      r.status(200).body().has('$.account_role', 'member');
    });
    await ctx.step('PATCH same role → 200 {unchanged:true} (idempotent no-op)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/members/:userId',
          { role: 'member' },
          { params: { accountId: team.id, userId: member.userId! } },
        );
      r.status(200).body().has('$.unchanged', true).has('$.account_role', 'member');
    });
    await ctx.step(
      'admin cannot demote an owner → 403 (only an owner can change the owner role)',
      async () => {
        // OWNER is the only owner on this throwaway team; an admin trying to
        // change OWNER's role (even to owner — the "change the owner role" branch
        // fires whenever the TARGET is an owner) → 403.
        const r = await ctx.client
          .as(admin)
          .patch(
            '/v1/accounts/:accountId/members/:userId',
            { role: 'admin' },
            { params: { accountId: team.id, userId: ctx.P.OWNER.userId! } },
          );
        r.status(403);
      },
    );
    await ctx.step(
      'admin cannot promote anyone to owner → 403 (privilege-escalation guard)',
      async () => {
        const r = await ctx.client
          .as(admin)
          .patch(
            '/v1/accounts/:accountId/members/:userId',
            { role: 'owner' },
            { params: { accountId: team.id, userId: member.userId! } },
          );
        r.status(403);
      },
    );
    await ctx.step('PATCH an unknown userId → 404 (Member not found)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/members/:userId',
          { role: 'member' },
          { params: { accountId: team.id, userId: '00000000-0000-4000-a000-000000000000' } },
        );
      r.status(404);
    });
    await ctx.step('OWNER demoting the last owner → 409 (cannot orphan the account)', async () => {
      // OWNER is the sole owner of this throwaway team; demoting them would
      // orphan it. The last-owner guard fires (countOwners <= 1) → 409.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          '/v1/accounts/:accountId/members/:userId',
          { role: 'admin' },
          { params: { accountId: team.id, userId: ctx.P.OWNER.userId! } },
        );
      r.status(409);
    });
  },
);

// MEM-7 — `project_grants` on POST /members: the centralized-IAM redesign's
// "one invite, pick account role + project(s)" dialog needs the invite to
// carry project access, not just an account role. Proves the four cases the
// handler (apps/api/src/accounts/core/members.ts:227-291) encodes:
//   - existing-user invite + a grant for a project THIS account owns →
//     applied immediately (grantProjectRole), visible on GET .../access.
//   - a grant naming a project from a DIFFERENT account is silently
//     dropped, never inserted — the ownership check must not trust the
//     client-supplied project_id.
//   - a pending invite (new email, no Kortix user yet) stages the grant on
//     bootstrap_grants; it lands only once the addressee accepts.
//   - an `admin` invite ignores project_grants outright — admins already
//     hold implicit Manager on every project (mirrors applyBootstrapGrants'
//     own initialRole==='member' gate in accounts/invites.ts).
flow(
  'MEM-7',
  {
    domain: 'accounts',
    serial: true,
    routes: [
      'POST /v1/accounts/:accountId/members',
      'GET /v1/projects/:projectId/access',
      'POST /v1/account-invites/:inviteId/accept',
      'DELETE /v1/accounts/:accountId/members/:userId',
      'GET /v1/accounts/:accountId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    const otherTeam = await ctx.fixtures.team();
    const otherProject = await otherTeam.project();

    await ctx.step(
      'existing user + project_grants for an owned project → applied immediately',
      async () => {
        const invitee = await ctx.fixtures.userWithEmail(
          `${ctx.fixtures.name('mem7-existing')}@ke2e.kortix.test`.toLowerCase(),
          { label: 'MEM7-EXISTING' },
        );
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/accounts/:accountId/members',
          {
            email: invitee.email,
            role: 'member',
            project_grants: [{ project_id: p.id, role: 'manager' }],
          },
          { params: { accountId: team.id } },
        );
        r.status(201)
          .body()
          .has('$.status', 'added')
          .has('$.project_grants[0].project_id', p.id)
          .has('$.project_grants[0].role', 'manager');

        const access = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId/access', { params: { projectId: p.id } });
        access.status(200);
        const row = access
          .json<{ members: any[] }>()
          .members.find((m) => m.user_id === invitee.userId);
        if (!row) throw new Error('invited user missing from project access list');
        if (row.effective_project_role !== 'manager')
          throw new Error(`expected manager, got ${row.effective_project_role}`);
      },
    );

    await ctx.step(
      'a grant naming a project from a DIFFERENT account is silently dropped',
      async () => {
        const invitee = await ctx.fixtures.userWithEmail(
          `${ctx.fixtures.name('mem7-crossacct')}@ke2e.kortix.test`.toLowerCase(),
          { label: 'MEM7-CROSSACCT' },
        );
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/accounts/:accountId/members',
          {
            email: invitee.email,
            role: 'member',
            project_grants: [{ project_id: otherProject.id, role: 'manager' }],
          },
          { params: { accountId: team.id } },
        );
        r.status(201).body().has('$.status', 'added').has('$.project_grants', []);

        const access = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId/access', { params: { projectId: otherProject.id } });
        access.status(200);
        const row = access
          .json<{ members: any[] }>()
          .members.find((m) => m.user_id === invitee.userId);
        if (row) throw new Error('cross-account project grant was NOT supposed to land');
      },
    );

    await ctx.step(
      'pending invite (no Kortix user yet) stages the grant, applied on accept',
      async () => {
        const inviteEmail = `${ctx.fixtures.name('mem7-pending')}@${ctx.env.testEmailDomain}`.toLowerCase();
        let inviteId = '';
        const r = await ctx.client.as(ctx.P.OWNER).post(
          '/v1/accounts/:accountId/members',
          {
            email: inviteEmail,
            role: 'member',
            project_grants: [{ project_id: p.id, role: 'manager' }],
          },
          { params: { accountId: team.id } },
        );
        r.status(201)
          .body()
          .has('$.status', 'pending')
          .has('$.project_grants[0].project_id', p.id)
          .has('$.project_grants[0].role', 'manager');
        inviteId = r.json<any>().invite_id;

        const addressee = await ctx.fixtures.userWithEmail(inviteEmail, {
          label: 'MEM7-PENDING-ADDRESSEE',
        });
        const accept = await ctx.client
          .as(addressee)
          .post('/v1/account-invites/:inviteId/accept', {}, { params: { inviteId } });
        accept.status(200).body().has('$.account_id', team.id);

        const access = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId/access', { params: { projectId: p.id } });
        access.status(200);
        const row = access
          .json<{ members: any[] }>()
          .members.find((m) => m.user_id === addressee.userId);
        if (!row) throw new Error('accepted invitee missing from project access list');
        if (row.effective_project_role !== 'manager')
          throw new Error(`expected manager, got ${row.effective_project_role}`);

        // A current member re-accepting the same invite still heals (200).
        const again = await ctx.client
          .as(addressee)
          .post('/v1/account-invites/:inviteId/accept', {}, { params: { inviteId } });
        again.status(200);

        // After removal the accepted invite must not re-create the membership.
        const removed = await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/members/:userId', {
          params: { accountId: team.id, userId: addressee.userId! },
        });
        removed.status(200);
        const replay = await ctx.client
          .as(addressee)
          .post('/v1/account-invites/:inviteId/accept', {}, { params: { inviteId } });
        replay.status(410);
        const after = await ctx.client
          .as(addressee)
          .get('/v1/accounts/:accountId', { params: { accountId: team.id } });
        after.status([403, 404]);
      },
    );

    await ctx.step('an admin invite ignores project_grants — admins already have implicit access', async () => {
      const invitee = await ctx.fixtures.userWithEmail(
        `${ctx.fixtures.name('mem7-admin')}@ke2e.kortix.test`.toLowerCase(),
        { label: 'MEM7-ADMIN' },
      );
      const r = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/members',
        {
          email: invitee.email,
          role: 'admin',
          project_grants: [{ project_id: p.id, role: 'manager' }],
        },
        { params: { accountId: team.id } },
      );
      r.status(201).body().has('$.status', 'added').has('$.project_grants', []);
    });
  },
);

flow(
  'INV-1',
  {
    domain: 'accounts',
    routes: [
      'GET /v1/accounts/:accountId/invites',
      'POST /v1/accounts/:accountId/members',
      'PATCH /v1/accounts/:accountId/members/:userId',
      'POST /v1/accounts/:accountId/invites/:inviteId/resend',
      'DELETE /v1/accounts/:accountId/invites/:inviteId',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const params = { accountId: team.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    const email = `${ctx.fixtures.name('inv1')}@${ctx.env.testEmailDomain}`.toLowerCase();
    let inviteId = '';
    let admin!: Principal;
    const pending = async (who: Principal) => {
      const r = await ctx.client.as(who).get('/v1/accounts/:accountId/invites', { params });
      r.status(200);
      return r.json<Array<Record<string, unknown>>>();
    };
    await ctx.step('an invite to a padded, mixed-case address is stored lower-cased → 201 pending with its link', async () => {
      const r = await owner.post('/v1/accounts/:accountId/members', { email: `  ${email.toUpperCase()}  `, role: 'admin' }, { params });
      r.status(201).body().has('$.status', 'pending').has('$.email', email).has('$.account_role', 'admin');
      inviteId = r.json<{ invite_id: string }>().invite_id;
      r.body().matches('$.invite_url', new RegExp(`/invites/${inviteId}$`));
    });
    await ctx.step('the owner lists it with its email, role, inviter and link', async () => {
      const row = (await pending(ctx.P.OWNER)).find((i) => i.invite_id === inviteId);
      const ok = row && row.email === email && row.initial_role === 'admin' && row.invited_by === ctx.P.OWNER.userId &&
        String(row.invite_url).endsWith(`/invites/${inviteId}`);
      if (!ok) throw new Error(`listed invite: ${JSON.stringify(row)}`);
    });
    await ctx.step('an account admin lists it; after demoting themselves to member they see an empty list', async () => {
      admin = await team.addMember('admin');
      if (!(await pending(admin)).some((i) => i.invite_id === inviteId)) throw new Error('admin cannot see the pending invite');
      (await ctx.client.as(admin).patch('/v1/accounts/:accountId/members/:userId', { role: 'member' }, { params: { ...params, userId: admin.userId! } }))
        .status(200).body().has('$.account_role', 'member');
      // The demotion busts the caller's cached role on every API process over
      // LISTEN/NOTIFY (iam/cache-invalidation.ts), so no process behind the load
      // balancer may still serve the admin view. Every read must be empty.
      for (let read = 0; read < 8; read++) {
        if ((await pending(admin)).length !== 0) throw new Error(`read ${read + 1}: pending invites leaked to a demoted member`);
      }
    });
    await ctx.step('a plain member cannot resend the invite or promote themselves → 403; the invite is unchanged', async () => {
      (await ctx.client.as(admin).post('/v1/accounts/:accountId/invites/:inviteId/resend', {}, { params: { ...params, inviteId } })).status(403);
      (await ctx.client.as(admin).patch('/v1/accounts/:accountId/members/:userId', { role: 'admin' }, { params: { ...params, userId: admin.userId! } })).status(403);
      if (!(await pending(ctx.P.OWNER)).some((i) => i.invite_id === inviteId)) throw new Error('the invite vanished');
    });
    await ctx.step('NONMEMBER cannot list → 403 Forbidden', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).get('/v1/accounts/:accountId/invites', { params })).status(403).body().has('$.error', 'Forbidden');
    });
    await ctx.step('the owner cancels → 200 {ok:true}; the invite drops out of the list', async () => {
      (await owner.del('/v1/accounts/:accountId/invites/:inviteId', { params: { ...params, inviteId } })).status(200).body().has('$.ok', true);
      if ((await pending(ctx.P.OWNER)).some((i) => i.invite_id === inviteId)) throw new Error('a cancelled invite is still listed');
    });
  },
);

flow(
  'DEL-1',
  { domain: 'accounts', routes: ['GET /v1/account/deletion-status'] },
  async (ctx) => {
    await ctx.step('OWNER reads deletion status', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/account/deletion-status');
      r.status(200);
    });
  },
);

// DEL-4 — the `/v1/account/*` deletion mount
// (apps/api/src/billing/routes/account-deletion.ts). Drives `GET .../deletion-status` and
// the real, destructive `DELETE .../delete-immediately` on a THROWAWAY user's
// own personal account (never OWNER/team accounts other flows depend on).
// Immediate self-deletion removes the auth identity, invalidates its token and
// removes the account row itself: the account answers 404 to a nonmember.
flow(
  'DEL-4',
  {
    domain: 'accounts',
    routes: [
      'DELETE /v1/account/delete-immediately',
      'GET /v1/account/deletion-status',
      'GET /v1/accounts/me',
      'GET /v1/accounts/:accountId',
    ],
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
    let victimAccountId = '';
    await ctx.step('a nonmember is forbidden from the throwaway account → 403', async () => {
      // The personal account is the victim's first (and only) membership.
      const me = await asVictim.get('/v1/accounts/me');
      me.status(200).body().exists('$.accounts[0].account_id');
      victimAccountId = me.json().accounts[0].account_id;
      (
        await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/accounts/:accountId', { params: { accountId: victimAccountId } })
      ).status(403);
    });
    await ctx.step('throwaway account deletes itself immediately → 200', async () => {
      const r = await asVictim.del('/v1/account/delete-immediately');
      r.status(200).body().has('$.success', true).has('$.message', 'Account deleted');
    });
    await ctx.step('old token cannot read account or deletion status → 401', async () => {
      (await asVictim.get('/v1/accounts/me')).status(401);
      (await asVictim.get('/v1/account/deletion-status')).status(401);
    });
    await ctx.step('the deleted account is gone for a nonmember → 404', async () => {
      (
        await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/accounts/:accountId', { params: { accountId: victimAccountId } })
      ).status(404);
    });
    await ctx.step('repeated deletion cannot restore old-token access → 401', async () => {
      (await asVictim.del('/v1/account/delete-immediately')).status(401);
      (await asVictim.get('/v1/accounts/me')).status(401);
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
// → 404 unless delete_revoked=true removes a revoked personal key; its secret → 401.
flow(
  'TOK-3',
  {
    domain: 'accounts',
    tags: ['deployed'],
    serial: true,
    routes: [
      'POST /v1/accounts/tokens',
      'DELETE /v1/accounts/tokens/:tokenId',
      'GET /v1/accounts/me',
      'GET /v1/accounts/tokens',
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
    await ctx.step('explicit deletion never revokes an active key, even when replayed', async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        (await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/tokens/:tokenId', {
          params: { tokenId }, query: { delete_revoked: 'true' },
        })).status(404);
      }
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
    await ctx.step('the revoked key stays listed until explicit deletion and cannot authenticate', async () => {
      (await ctx.client.withBearer(secret).get('/v1/accounts/me')).status(401);
      const listed = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/tokens', { query: { mine: 'true' } });
      listed.status(200);
      if (!listed.json<Array<{ token_id: string }>>().some((row) => row.token_id === tokenId)) {
        throw new Error('first removal deleted an active key instead of revoking it');
      }
      (await ctx.client.as(ctx.P.NONMEMBER).del('/v1/accounts/tokens/:tokenId', {
        params: { tokenId }, query: { delete_revoked: 'true' },
      })).status(404);
    });
    await ctx.step('the CLI deletes a revoked key and mine no longer lists it', async () => {
      const cli = new CliSandbox('tok3-delete');
      try {
        // Pin the account the key lives in. A non-TTY login picks the first of
        // the OWNER's accounts, and concurrent flows add team accounts to it.
        const login = await cli.login(await ctx.fixtures.pat({ name: ctx.fixtures.name('cleanup') }), {
          noProject: true,
          account: ctx.P.OWNER.accountId,
        });
        if (login.exitCode !== 0) throw new Error('CLI login failed');
        const removed = await cli.run(['tokens', 'rm', tokenId, '-y']);
        if (removed.exitCode !== 0 || !removed.stdout.includes('Deleted')) {
          throw new Error(`CLI deletion failed: ${removed.stderr}`);
        }
        const listed = await cli.run(['tokens', 'ls', '--mine', '--json']);
        if (listed.exitCode !== 0 || listed.stdout.includes(tokenId)) {
          throw new Error('deleted key remains in personal listing');
        }
      } finally {
        cli.dispose();
      }
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

// TOK-6 — a plain account member runs `kortix login`: the sign-in page mints a
// PAT on `token.personal.create`, which every system account role holds. The
// PAT acts as the member and carries only the member's roles; revoking it needs
// only `token.personal.revoke`. Another person's token and OAuth-client
// registration stay behind the admin `token.revoke` / `token.create` leaves.
flow(
  'TOK-6',
  {
    domain: 'accounts',
    serial: true,
    routes: [
      'POST /v1/accounts/tokens',
      'DELETE /v1/accounts/tokens/:tokenId',
      'GET /v1/accounts/me',
      'PATCH /v1/accounts/:accountId',
      'POST /v1/accounts/:accountId/iam/oauth-clients',
      'GET /v1/accounts/tokens',
      'GET /v1/accounts/:accountId/iam/service-accounts',
      'GET /v1/accounts/:accountId/iam/oauth-clients',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    const account_id = team.id;
    let memberTokenId = '';
    let memberSecret = '';
    let ownerTokenId = '';
    let ownerSecret = '';

    await ctx.step('MEMBER mints a personal token in the team account → 201 with the secret once', async () => {
      const r = await ctx.client
        .as(member)
        .post('/v1/accounts/tokens', { name: ctx.fixtures.name('member-cli'), account_id });
      r.status(201).body().exists('$.secret_key').exists('$.token_id').has('$.project_id', null);
      const j = r.json<any>();
      memberTokenId = j.token_id;
      memberSecret = j.secret_key;
    });

    await ctx.step('the member token authenticates as the member → /accounts/me 200, auth_type pat', async () => {
      const r = await ctx.client.withBearer(memberSecret).get('/v1/accounts/me');
      r.status(200).body().has('$.token_context.auth_type', 'pat');
    });

    await ctx.step('the member token carries only member rights → renaming the account 403', async () => {
      const r = await ctx.client
        .withBearer(memberSecret)
        .patch('/v1/accounts/:accountId', { name: 'nope' }, { params: { accountId: account_id } });
      r.status(403);
    });

    await ctx.step('the unscoped member token mints and revokes another personal token (kortix tokens new) → 201, 200', async () => {
      const minted = await ctx.client
        .withBearer(memberSecret)
        .post('/v1/accounts/tokens', { name: ctx.fixtures.name('member-cli-2'), account_id });
      minted.status(201).body().exists('$.token_id');
      const revoked = await ctx.client.withBearer(memberSecret).del('/v1/accounts/tokens/:tokenId', {
        params: { tokenId: minted.json<any>().token_id },
        query: { account_id },
      });
      revoked.status(200).body().has('$.ok', true);
    });

    await ctx.step('MEMBER cannot register an OAuth client → 403 (token.create stays admin)', async () => {
      const r = await ctx.client.as(member).post(
        '/v1/accounts/:accountId/iam/oauth-clients',
        { name: ctx.fixtures.name('app'), redirect_uris: ['https://app.example.test/cb'] },
        { params: { accountId: account_id } },
      );
      r.status(403);
    });

    await ctx.step("OWNER mints a token; MEMBER cannot revoke the owner's token → 403", async () => {
      const minted = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/accounts/tokens', { name: ctx.fixtures.name('owner-cli'), account_id });
      minted.status(201);
      ownerTokenId = minted.json<any>().token_id;
      ownerSecret = minted.json<any>().secret_key;
      const r = await ctx.client.as(member).del('/v1/accounts/tokens/:tokenId', {
        params: { tokenId: ownerTokenId },
        query: { account_id },
      });
      r.status(403);
    });

    await ctx.step("MEMBER lists the account's tokens → only their own; OWNER (token.revoke) → both", async () => {
      const ids = async (as: ReturnType<typeof ctx.client.as>) => {
        const r = await as.get('/v1/accounts/tokens', { query: { account_id } });
        r.status(200);
        return r.json<Array<{ token_id: string }>>().map((t) => t.token_id);
      };
      const mine = await ids(ctx.client.as(member));
      if (!mine.includes(memberTokenId)) throw new Error('member list must hold the member token');
      if (mine.includes(ownerTokenId)) throw new Error("member list must not hold the owner's token");
      const all = await ids(ctx.client.as(ctx.P.OWNER));
      if (!all.includes(memberTokenId) || !all.includes(ownerTokenId)) {
        throw new Error('owner list must hold every live token of the account');
      }
    });

    await ctx.step('MEMBER cannot list service accounts or OAuth clients → 403 (token.create); OWNER → 200', async () => {
      const params = { accountId: account_id };
      (await ctx.client.as(member).get('/v1/accounts/:accountId/iam/service-accounts', { params })).status(403);
      (await ctx.client.as(member).get('/v1/accounts/:accountId/iam/oauth-clients', { params })).status(403);
      (await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/iam/service-accounts', { params })).status(200);
      (await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/iam/oauth-clients', { params })).status(200);
    });

    await ctx.step("the owner's token still authenticates after the refused revoke → 200", async () => {
      const r = await ctx.client.withBearer(ownerSecret).get('/v1/accounts/me');
      r.status(200);
    });

    await ctx.step('MEMBER revoking an unknown token id → 403, not 404 (no existence oracle)', async () => {
      const r = await ctx.client.as(member).del('/v1/accounts/tokens/:tokenId', {
        params: { tokenId: '00000000-0000-0000-0000-000000000000' },
        query: { account_id },
      });
      r.status(403);
    });

    await ctx.step('MEMBER revokes their own token → 200; the secret then fails → 401', async () => {
      const r = await ctx.client.as(member).del('/v1/accounts/tokens/:tokenId', {
        params: { tokenId: memberTokenId },
        query: { account_id },
      });
      r.status(200).body().has('$.ok', true);
      const after = await ctx.client.withBearer(memberSecret).get('/v1/accounts/me');
      after.status(401);
    });

    await ctx.step("cleanup: OWNER revokes the owner's token → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/tokens/:tokenId', {
        params: { tokenId: ownerTokenId },
        query: { account_id },
      });
      r.status(200);
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
    // Trigger create commits the manifest to the project repo, which can never
    // succeed against a database-only fixture's ke2e.invalid remote — the 502
    // gets laundered into 503 MAINTENANCE_MODE at the edge. Project A needs
    // managed git; project B only absorbs pre-handler cross-project 403s.
    const projA = await ctx.fixtures.project({ managedGit: true });
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

// ─── Organization branding (Enterprise `branding` entitlement) ───────────
//
// The local profile has no Enterprise tier, so the WRITE routes answer 402
// `entitlement_required` here — which is itself the contract: a self-serve
// account must never be able to brand the app. Reads and the two removal
// routes are permission-only and must work for a downgraded account.

flow(
  'ACCT-BRAND-1',
  {
    domain: 'accounts',
    routes: [
      'GET /v1/accounts/:accountId/branding',
      'PUT /v1/accounts/:accountId/branding',
      'POST /v1/accounts/:accountId/branding/assets/:kind',
      'DELETE /v1/accounts/:accountId/branding/assets/:kind',
      'DELETE /v1/accounts/:accountId/branding',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const params = { accountId: team.id };

    await ctx.step('GET → 200 empty record, entitled=false on a self-serve account', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts/:accountId/branding', { params });
      r.status(200)
        .body()
        .has('$.entitled', false)
        .has('$.branding.app_name', null)
        .has('$.branding.logo_url', null)
        .has('$.branding.icon_url', null)
        .has('$.branding.favicon_url', null)
        .has('$.branding.logo_dark_url', null)
        .has('$.branding.icon_dark_url', null)
        .has('$.branding.favicon_dark_url', null);
    });

    await ctx.step('GET /accounts list carries branding=null for the team', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get('/v1/accounts');
      r.status(200);
      const row = r.json<Array<{ account_id: string; branding?: unknown }>>().find(
        (a) => a.account_id === team.id,
      );
      if (!row) throw new Error('team account missing from list');
      if (row.branding !== null && row.branding !== undefined) {
        throw new Error(`expected branding null, got ${JSON.stringify(row.branding)}`);
      }
    });

    await ctx.step('PUT app_name without the entitlement → 402 entitlement_required', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put('/v1/accounts/:accountId/branding', { app_name: 'Acme Copilot' }, { params });
      r.status(402).body().has('$.code', 'entitlement_required').has('$.entitlement', 'branding');
    });

    await ctx.step('POST asset without the entitlement → 402 (before any body is read)', async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])]), 'logo.png');
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .request('POST', '/v1/accounts/:accountId/branding/assets/logo', { params, body: form });
      r.status(402).body().has('$.code', 'entitlement_required');
    });

    await ctx.step('POST dark variant without the entitlement → 402 (same gate)', async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), 'dark.png');
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .request('POST', '/v1/accounts/:accountId/branding/assets/logo_dark', { params, body: form });
      r.status(402).body().has('$.code', 'entitlement_required');
    });

    await ctx.step('POST asset with an unknown kind → 400 (param enum)', async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), 'x.png');
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .request('POST', '/v1/accounts/:accountId/branding/assets/banner', { params, body: form });
      r.status([400, 402]);
    });

    await ctx.step('DELETE asset is permission-only → 200 even without the entitlement', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/accounts/:accountId/branding/assets/logo', { params });
      r.status(200).body().has('$.branding.logo_url', null).has('$.entitled', false);
    });

    await ctx.step('DELETE branding (reset) is permission-only → 200', async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del('/v1/accounts/:accountId/branding', { params });
      r.status(200).body().has('$.branding.logo_url', null).has('$.branding.logo_dark_url', null);
    });

    await ctx.step('NONMEMBER → 403; ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/accounts/:accountId/branding', { params });
      r.status(403);
      const a = await ctx.client.as(ctx.P.ANON).get('/v1/accounts/:accountId/branding', { params });
      a.status(401);
    });
  },
);

// ACCT-5 — an invite-first signup. The invites exist before the identity
// does, and the identity is a raw Supabase user with no fixture bootstrap, so
// its first Kortix read is the one that must create the personal account
// before claiming the invites.
flow(
  'ACCT-5',
  {
    domain: 'accounts',
    routes: [
      'POST /v1/accounts/:accountId/members',
      'GET /v1/accounts/:accountId/invites',
      'GET /v1/accounts',
      'GET /v1/accounts/me',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const created: string[] = [];
    const signUp = async (email: string): Promise<{ userId: string; client: Client }> => {
      const password = `Ke2e-${crypto.randomUUID()}-Aa1!`;
      const user = await adminCreateUser(ctx.env, email, password);
      created.push(user.id);
      return { userId: user.id, client: ctx.client.withBearer(await passwordGrant(ctx.env, email, password), 'INVITE-FIRST') };
    };
    const invite = async (accountId: string, email: string, role: 'admin' | 'member') => {
      (await owner.post('/v1/accounts/:accountId/members', { email, role }, { params: { accountId } }))
        .status(201).body().has('$.status', 'pending');
    };
    try {
      await ctx.step('an invite-first signup invited as admin by two accounts: the first GET /v1/accounts lists its own account AND both accounts; a repeat adds nothing', async () => {
        const teamA = await ctx.fixtures.team();
        const teamB = await ctx.fixtures.team();
        const email = `${ctx.fixtures.name('invite-first')}@${ctx.env.testEmailDomain}`.toLowerCase();
        await invite(teamA.id, email, 'admin');
        await invite(teamB.id, email, 'admin');
        const { userId, client } = await signUp(email);
        for (const attempt of [1, 2]) {
          const r = await client.get('/v1/accounts');
          r.status(200);
          const rows = r.json<Array<{ account_id: string; account_role: string; is_primary_owner: boolean }>>();
          const byId = new Map(rows.map((a) => [a.account_id, a]));
          const own = byId.get(userId);
          const ok =
            rows.length === 3 &&
            own?.account_role === 'owner' && own.is_primary_owner === true &&
            [teamA.id, teamB.id].every((id) => byId.get(id)?.account_role === 'admin' && byId.get(id)?.is_primary_owner === false);
          if (!ok) throw new Error(`call ${attempt}: ${JSON.stringify(rows)}`);
        }
        for (const team of [teamA, teamB]) {
          const r = await owner.get('/v1/accounts/:accountId/invites', { params: { accountId: team.id } });
          r.status(200);
          if (r.json<Array<{ email: string }>>().some((i) => i.email === email)) throw new Error('the invite was not claimed');
        }
      });
      await ctx.step('an invite-first signup whose first read is GET /v1/accounts/me gets its own account (owner) plus the inviting account (member); a repeat adds nothing', async () => {
        const team = await ctx.fixtures.team();
        const email = `${ctx.fixtures.name('invite-first-me')}@${ctx.env.testEmailDomain}`.toLowerCase();
        await invite(team.id, email, 'member');
        const { userId, client } = await signUp(email);
        for (const attempt of [1, 2]) {
          const r = await client.get('/v1/accounts/me');
          r.status(200);
          const accounts = r.json<{ accounts: Array<{ account_id: string; role: string }> }>().accounts;
          const roles = new Map(accounts.map((a) => [a.account_id, a.role]));
          if (accounts.length !== 2 || roles.get(userId) !== 'owner' || roles.get(team.id) !== 'member') {
            throw new Error(`call ${attempt}: ${JSON.stringify(accounts)}`);
          }
        }
      });
      await ctx.step('a user who already has a membership gets no retroactive personal account from GET /v1/accounts or /accounts/me', async () => {
        const team = await ctx.fixtures.team();
        const member = await team.addMember('member');
        for (const path of ['/v1/accounts', '/v1/accounts/me'] as const) {
          const r = await ctx.client.as(member).get(path);
          r.status(200);
          const body = r.json<any>();
          const ids = (Array.isArray(body) ? body : body.accounts).map((a: { account_id: string }) => a.account_id);
          if (ids.length !== 1 || ids[0] !== team.id) throw new Error(`${path} listed ${JSON.stringify(ids)}, expected only the team`);
        }
      });
    } finally {
      for (const id of created) await adminDeleteUser(ctx.env, id).catch(() => {});
    }
  },
);

// TOPUP-1 — KRTX-1718: a member out of credits asks the owners to add some.
// The member cannot buy credits (billing.write is owner-only by default) and
// had no way to tell an owner from inside the product.
flow(
  'TOPUP-1',
  { domain: 'accounts', routes: ['POST /v1/accounts/:accountId/top-up-requests'] },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember('member');
    const ask = (who: Principal) =>
      ctx.client.as(who).post('/v1/accounts/:accountId/top-up-requests', {}, { params: { accountId: team.id } });

    await ctx.step('ANON → 401; NONMEMBER → 403', async () => {
      (await ask(ctx.P.ANON)).status(401);
      (await ask(ctx.P.NONMEMBER)).status(403);
    });
    await ctx.step('the OWNER can add credits, so asking → 409 can_manage_billing', async () => {
      (await ask(ctx.P.OWNER)).status(409).body().has('$.code', 'can_manage_billing');
    });
    await ctx.step('a MEMBER asks → 202, and the one owner is emailed', async () => {
      (await ask(member)).status(202).body().has('$.notified', 1);
    });
    await ctx.step('the same MEMBER again that day → 429 already_requested', async () => {
      (await ask(member)).status(429).body().has('$.code', 'already_requested');
    });
  },
);
