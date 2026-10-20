import { beforeEach, describe, expect, test, vi } from 'vitest';
import { api, components, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { PROXY_SECRET, addMember, lumenTest, org, signedInUser } from './setup';

// The Kortix SDK, faked at the module edge: every token mint and revoke is counted.
// (Vitest cannot load the SDK's TypeScript source graph; Convex bundles it with esbuild.)
const kortixFake = vi.hoisted(() => {
  const mints: Array<{ name: string; projectId: string; expiresAt: string }> = [];
  const revokes: string[] = [];
  return {
    mints,
    revokes,
    provision: { fail: false },
    client: {
      projects: {
        provision: async () => {
          if (kortixFake.provision.fail) throw new Error('502: upstream exploded at 10.0.0.7');
          return { project_id: 'proj_new' };
        },
      },
      accounts: {
        tokens: {
          create: async (input: { name: string; projectId: string; expiresAt: string }) => {
            mints.push(input);
            return { token_id: `tok_${mints.length}`, secret_key: `kortix_pat_${mints.length}` };
          },
          revoke: async (id: string) => void revokes.push(id),
        },
      },
    },
  };
});
vi.mock('@kortix/sdk/server', () => ({ createScopedKortix: () => kortixFake.client, runWithKortix: () => {} }));
vi.mock('@kortix/sdk', () => ({ updateAgentConfig: () => {}, updateProjectDefaultAgent: () => {} }));
const mints = kortixFake.mints;
beforeEach(() => {
  mints.length = 0;
  kortixFake.revokes.length = 0;
  kortixFake.provision.fail = false;
});

async function world() {
  const t = lumenTest();
  const acme = await org(t, 'Acme Capital');
  const alice = await signedInUser(t, 'alice@example.test');
  const mallory = await signedInUser(t, 'mallory@example.test');
  await addMember(t, acme, alice.userId, 'owner');
  const ready = await t.run((ctx) =>
    ctx.db.insert('workspaces', {
      orgId: acme, name: 'Deals', templateSlug: 'finance-analyst', kortixProjectId: 'proj_1', status: 'ready', createdBy: alice.userId,
    }),
  );
  const provisioning = await t.run((ctx) =>
    ctx.db.insert('workspaces', {
      orgId: acme, name: 'New', templateSlug: 'finance-analyst', kortixProjectId: null, status: 'provisioning', createdBy: alice.userId,
    }),
  );
  return { t, acme, alice, mallory, ready, provisioning };
}

type As = Awaited<ReturnType<typeof signedInUser>>['as'];
const token = (as: As, workspaceId: string, proxySecret = PROXY_SECRET) =>
  as.action(api.kortix.memberToken, { workspaceId, proxySecret });

describe('memberToken: who gets a Kortix token for which workspace', () => {
  test('a member gets a project-scoped, expiring token for the workspace project', async () => {
    const { alice, ready } = await world();
    const got = await token(alice.as, ready);
    expect(got.projectId).toBe('proj_1');
    expect(got.token).toBe('kortix_pat_1');
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatchObject({ projectId: 'proj_1', name: `lumen-member-${alice.userId}` });
    expect(Date.parse(mints[0].expiresAt)).toBe(got.expiresAt);
  });

  test('a stored token with more than 5 minutes left is reused; one closer to expiry is replaced', async () => {
    const { t, alice, ready } = await world();
    const first = await token(alice.as, ready);
    expect((await token(alice.as, ready)).token).toBe(first.token);
    expect(mints).toHaveLength(1);

    await t.run(async (ctx) => {
      const row = (await ctx.db.query('memberTokens').collect())[0];
      await ctx.db.patch(row._id, { expiresAt: Date.now() + 4 * 60_000 });
    });
    expect((await token(alice.as, ready)).token).toBe('kortix_pat_2');
    expect(mints).toHaveLength(2);
    // Still one row per (workspace, member).
    expect(await t.run((ctx) => ctx.db.query('memberTokens').collect())).toHaveLength(1);
  });

  test('every minted token has its revoke scheduled at expiry', async () => {
    const { t, alice, ready } = await world();
    const got = await token(alice.as, ready);
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    const revoke = jobs.find((j) => j.name.includes('revokeToken'));
    expect(revoke?.args).toEqual([{ tokenId: 'tok_1' }]);
    expect(revoke?.scheduledTime).toBe(got.expiresAt);
  });

  test('a non-member, a provisioning workspace, an unknown id and a wrong proxy secret are refused, and nothing is minted', async () => {
    const { mallory, alice, ready, provisioning } = await world();
    await expect(token(mallory.as, ready)).rejects.toThrow(/403: not a member/);
    await expect(token(alice.as, provisioning)).rejects.toThrow(/409: /);
    await expect(token(alice.as, 'not-a-workspace-id')).rejects.toThrow(/404: /);
    await expect(token(alice.as, ready, 'wrong')).rejects.toThrow(/403: proxy only/);
    expect(mints).toHaveLength(0);
  });

  test('a member removed from the org is refused on the next call', async () => {
    const { t, alice, ready, acme } = await world();
    await token(alice.as, ready);
    await t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'member', where: [{ field: 'userId', value: alice.userId }, { field: 'organizationId', value: acme }] },
    } as never);
    await expect(token(alice.as, ready)).rejects.toThrow(/403: not a member/);
  });
});

describe('threads.recordFromProxy: one Lumen thread per Kortix session', () => {
  test('recording the same session twice keeps one thread and one audit event', async () => {
    const { t, alice, ready } = await world();
    const args = { workspaceId: ready as Id<'workspaces'>, kortixSessionId: 'sess_1', title: '  Q3   ', proxySecret: PROXY_SECRET };
    const a = await alice.as.mutation(api.threads.recordFromProxy, args);
    const b = await alice.as.mutation(api.threads.recordFromProxy, { ...args, title: 'other' });
    expect(b).toBe(a);
    const threads = await t.run((ctx) => ctx.db.query('threads').collect());
    expect(threads.map((th) => [th.kortixSessionId, th.title, th.createdBy])).toEqual([['sess_1', 'Q3', alice.userId]]);
    const audits = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audits.filter((e) => e.action === 'thread.create')).toHaveLength(1);
  });

  test('a non-member or a caller without the proxy secret cannot record a thread', async () => {
    const { alice, mallory, ready } = await world();
    const args = { workspaceId: ready as Id<'workspaces'>, kortixSessionId: 'sess_2', title: 'x', proxySecret: PROXY_SECRET };
    await expect(mallory.as.mutation(api.threads.recordFromProxy, args)).rejects.toThrow(/403: not a member/);
    await expect(alice.as.mutation(api.threads.recordFromProxy, { ...args, proxySecret: 'nope' })).rejects.toThrow(/403: proxy only/);
  });
});

describe('threads.renameFromProxy: a rename through the proxy renames the thread', () => {
  test('the title follows the session name; a non-member, a wrong secret and another workspace change nothing', async () => {
    const { t, alice, mallory, ready, provisioning } = await world();
    const ws = ready as Id<'workspaces'>;
    await alice.as.mutation(api.threads.recordFromProxy, { workspaceId: ws, kortixSessionId: 'sess_r', title: 'old', proxySecret: PROXY_SECRET });
    const args = { workspaceId: ws, kortixSessionId: 'sess_r', title: '  Q3 plan ', proxySecret: PROXY_SECRET };
    await expect(mallory.as.mutation(api.threads.renameFromProxy, args)).rejects.toThrow(/403: not a member/);
    await expect(alice.as.mutation(api.threads.renameFromProxy, { ...args, proxySecret: 'nope' })).rejects.toThrow(/403: proxy only/);
    await alice.as.mutation(api.threads.renameFromProxy, { ...args, workspaceId: provisioning as Id<'workspaces'>, title: 'wrong' });
    await alice.as.mutation(api.threads.renameFromProxy, { ...args, title: '   ' });
    expect((await t.run((ctx) => ctx.db.query('threads').collect())).map((th) => th.title)).toEqual(['old']);
    await alice.as.mutation(api.threads.renameFromProxy, args);
    expect((await t.run((ctx) => ctx.db.query('threads').collect())).map((th) => th.title)).toEqual(['Q3 plan']);
  });
});

describe('threads.deleteFromProxy: only the creator or an admin deletes a thread', () => {
  test('a plain member cannot delete another member\'s thread; the creator and an owner can', async () => {
    const { t, acme, alice, ready } = await world();
    const bob = await signedInUser(t, 'bob@example.test');
    const carol = await signedInUser(t, 'carol@example.test');
    await addMember(t, acme, bob.userId, 'member');
    await addMember(t, acme, carol.userId, 'member');
    const ws = ready as Id<'workspaces'>;
    await bob.as.mutation(api.threads.recordFromProxy, { workspaceId: ws, kortixSessionId: 'sess_b', title: 'b', proxySecret: PROXY_SECRET });
    await bob.as.mutation(api.threads.recordFromProxy, { workspaceId: ws, kortixSessionId: 'sess_b2', title: 'b2', proxySecret: PROXY_SECRET });
    const del = (kortixSessionId: string, remove: boolean) => ({ workspaceId: ws, kortixSessionId, proxySecret: PROXY_SECRET, remove });

    await expect(carol.as.mutation(api.threads.deleteFromProxy, del('sess_b', false))).rejects.toThrow(/403: only the thread's creator/);
    await expect(carol.as.mutation(api.threads.deleteFromProxy, del('sess_b', true))).rejects.toThrow(/403/);
    await expect(bob.as.mutation(api.threads.deleteFromProxy, { ...del('sess_b', true), proxySecret: 'nope' })).rejects.toThrow(/403: proxy only/);
    await expect(bob.as.mutation(api.threads.deleteFromProxy, del('sess_none', false))).rejects.toThrow(/404/);

    await bob.as.mutation(api.threads.deleteFromProxy, del('sess_b', false));
    expect(await t.run((ctx) => ctx.db.query('threads').collect())).toHaveLength(2);
    await bob.as.mutation(api.threads.deleteFromProxy, del('sess_b', true));
    await alice.as.mutation(api.threads.deleteFromProxy, del('sess_b2', true));
    expect(await t.run((ctx) => ctx.db.query('threads').collect())).toHaveLength(0);
    const audits = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audits.filter((e) => e.action === 'thread.delete').map((e) => [e.actorId, e.detail])).toEqual([
      [bob.userId, 'sess_b'],
      [alice.userId, 'sess_b2'],
    ]);
  });
});

describe('provisionWorkspace: the customer sees a generic failure, the operator sees the cause', () => {
  async function provisioning() {
    const { t, provisioning, alice } = await world();
    await t.run((ctx) => ctx.db.insert('agentTemplates', {
      slug: 'finance-analyst', name: 'Finance analyst', tagline: '', vertical: 'finance', agent: { prompt: 'p' },
    }));
    return { t, ws: provisioning as Id<'workspaces'>, alice };
  }

  test('success settles the workspace ready with its Kortix project', async () => {
    const { t, ws } = await provisioning();
    await t.action(internal.kortix.provisionWorkspace, { workspaceId: ws });
    expect(await t.run((ctx) => ctx.db.get(ws))).toMatchObject({ status: 'ready', kortixProjectId: 'proj_new' });
  });

  test('a Kortix failure marks it failed with generic text and keeps the raw error in auditEvents only', async () => {
    const { t, ws, alice } = await provisioning();
    kortixFake.provision.fail = true;
    await t.action(internal.kortix.provisionWorkspace, { workspaceId: ws });
    const seen = await alice.as.query(api.workspaces.get, { workspaceId: ws });
    expect(seen).toMatchObject({ status: 'failed', error: 'Setup failed. Try again.' });
    const audit = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audit.find((e) => e.action === 'workspace.failed')?.detail).toContain('upstream exploded');
  });
});
