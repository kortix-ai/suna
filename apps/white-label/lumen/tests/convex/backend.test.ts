import { beforeEach, describe, expect, test, vi } from 'vitest';
import { api, components, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { verifyStripeSignature } from '../../convex/billing';
import { KIT } from '../../convex/kit/bundle.generated';
import { seatAvailable } from '../../convex/seats';
import { PROXY_SECRET, addMember, lumenTest, org, signedInUser } from './setup';

// The Kortix SDK, faked at the module edge: every token mint, revoke and folder is counted.
// (Vitest cannot load the SDK's TypeScript source graph; Convex bundles it with esbuild.)
const kortixFake = vi.hoisted(() => {
  const mints: Array<{ name: string; projectId: string; expiresAt: string }> = [];
  const revokes: string[] = [];
  const folders: string[] = [];
  const provisions: Array<Record<string, unknown>> = [];
  const kit = { written: [] as string[], agents: [] as string[], merged: 0 };
  return {
    kit,
    mints,
    revokes,
    folders,
    provisions,
    provision: { fail: false },
    client: {
      session: () => ({
        files: { list: async () => [], remove: async () => {}, write: async (path: string) => void kit.written.push(path) },
        commit: async () => ({ committed: true, pushed: true, nothing_to_do: false, branch: 'kit-branch', head_sha: 'abc' }),
        delete: async () => {},
      }),
      projects: {
        provision: async (input: Record<string, unknown>) => {
          provisions.push(input);
          if (kortixFake.provision.fail) throw new Error('502: Kortix upstream exploded at 10.0.0.7');
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
vi.mock('@kortix/sdk/server', () => ({
  createScopedKortix: () => kortixFake.client,
  runWithKortix: (_config: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@kortix/sdk', () => ({
  createProjectSession: async () => ({ session_id: 'kit_session' }),
  openChangeRequest: async () => ({ cr_id: 'cr_1' }),
  mergeChangeRequest: async () => void kortixFake.kit.merged++,
  updateAgentConfig: async (_p: string, name: string) => void kortixFake.kit.agents.push(name),
  updateProjectDefaultAgent: async () => {},
  updateFeatureFlag: async (_p: string, key: string, on: boolean) => void kortixFake.folders.push(`flag:${key}=${on}`),
  getProjectDrive: async () => ({ driveId: 'drive_1' }),
  makeDriveFolder: async (_d: string, path: string) => void kortixFake.folders.push(path),
}));
const mints = kortixFake.mints;
beforeEach(() => {
  mints.length = 0;
  kortixFake.revokes.length = 0;
  kortixFake.folders.length = 0;
  kortixFake.provisions.length = 0;
  kortixFake.provision.fail = false;
  kortixFake.kit.written.length = 0;
  kortixFake.kit.agents.length = 0;
  kortixFake.kit.merged = 0;
});

type T = ReturnType<typeof lumenTest>;

async function insertFirm(t: T, orgId: string, createdBy: string, patch: Record<string, unknown> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('firms', {
      orgId, name: 'Example & Co. Legal', practiceTags: [], sizeBand: '2-10', status: 'ready', kortixProjectId: 'proj_1',
      plan: 'trial', seats: 5, billingStatus: 'none', createdBy, ...patch,
    }),
  );
}

async function insertMatter(t: T, firmId: Id<'firms'>, createdBy: string, visibility: 'firm' | 'restricted' = 'firm') {
  return t.run((ctx) =>
    ctx.db.insert('matters', {
      firmId, name: visibility === 'firm' ? 'Project Aster' : 'Walled', client: 'Brightwater Example Holdings', parties: [],
      status: 'open', visibility, driveFolder: '/Company/Lumen/Matters/x', createdBy, updatedAt: Date.now(),
    }),
  );
}

/** One firm: alice owner, bob lawyer; mallory is in no firm. One open matter and one restricted to alice. */
async function world() {
  const t = lumenTest();
  const acme = await org(t, 'Example Co');
  const alice = await signedInUser(t, 'alice@example.com');
  const bob = await signedInUser(t, 'bob@example.com');
  const mallory = await signedInUser(t, 'mallory@example.com');
  await addMember(t, acme, alice.userId, 'owner');
  await addMember(t, acme, bob.userId, 'member');
  const firm = await insertFirm(t, acme, alice.userId);
  const matter = await insertMatter(t, firm, alice.userId);
  const walled = await insertMatter(t, firm, alice.userId, 'restricted');
  await t.run((ctx) => ctx.db.insert('matterMembers', { matterId: walled, userId: alice.userId }));
  return { t, acme, alice, bob, mallory, firm, matter, walled };
}

type As = Awaited<ReturnType<typeof signedInUser>>['as'];
const token = (as: As, matterId: string, proxySecret = PROXY_SECRET) => as.action(api.kortix.memberToken, { matterId, proxySecret });

describe('memberToken: who gets a Kortix token for which matter', () => {
  test('a member gets a project-scoped, expiring token for the firm project', async () => {
    const { alice, matter } = await world();
    const got = await token(alice.as, matter);
    expect(got.projectId).toBe('proj_1');
    expect(got.token).toBe('kortix_pat_1');
    expect(mints[0]).toMatchObject({ projectId: 'proj_1', name: `lumen-member-${alice.userId}` });
    expect(Date.parse(mints[0].expiresAt)).toBe(got.expiresAt);
  });

  test('one token per (firm, member): a second matter reuses it; one close to expiry is replaced', async () => {
    const { t, alice, matter, walled } = await world();
    const first = await token(alice.as, matter);
    expect((await token(alice.as, walled)).token).toBe(first.token);
    expect(mints).toHaveLength(1);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('memberTokens').collect())[0];
      await ctx.db.patch(row._id, { expiresAt: Date.now() + 4 * 60_000 });
    });
    expect((await token(alice.as, matter)).token).toBe('kortix_pat_2');
    expect(await t.run((ctx) => ctx.db.query('memberTokens').collect())).toHaveLength(1);
  });

  test('every minted token has its revoke scheduled at expiry', async () => {
    const { t, alice, matter } = await world();
    const got = await token(alice.as, matter);
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    const revoke = jobs.find((j) => j.name.includes('revokeToken'));
    expect(revoke?.args).toEqual([{ tokenId: 'tok_1' }]);
    expect(revoke?.scheduledTime).toBe(got.expiresAt);
  });

  test('refused: a non-member, a lawyer on a restricted matter, a provisioning firm, an unknown id, a wrong secret', async () => {
    const { t, acme, alice, bob, mallory, matter, walled } = await world();
    const pending = await insertFirm(t, acme, alice.userId, { status: 'provisioning', kortixProjectId: undefined, orgId: 'other' });
    const pendingMatter = await insertMatter(t, pending, alice.userId);
    await expect(token(mallory.as, matter)).rejects.toThrow(/403: not a member/);
    await expect(token(bob.as, walled)).rejects.toThrow(/403: no access to this matter/);
    await expect(token(alice.as, pendingMatter)).rejects.toThrow(/403|409/);
    await expect(token(alice.as, 'not-a-matter-id')).rejects.toThrow(/404: /);
    await expect(token(alice.as, matter, 'wrong')).rejects.toThrow(/403: proxy only/);
    expect(mints).toHaveLength(0);
  });

  test('a member removed from the org is refused on the next call', async () => {
    const { t, alice, matter, acme } = await world();
    await token(alice.as, matter);
    await t.mutation(components.betterAuth.adapter.deleteOne, {
      input: { model: 'member', where: [{ field: 'userId', value: alice.userId }, { field: 'organizationId', value: acme }] },
    } as never);
    await expect(token(alice.as, matter)).rejects.toThrow(/403: not a member/);
  });
});

describe('matters: visibility and roles', () => {
  test('a lawyer does not see a restricted matter in the list and gets "forbidden" on a direct read', async () => {
    const { alice, bob, firm, walled } = await world();
    const names = (rows: { name: string }[]) => rows.map((m) => m.name).sort();
    expect(names(await alice.as.query(api.matters.list, { firmId: firm }))).toEqual(['Project Aster', 'Walled']);
    expect(names(await bob.as.query(api.matters.list, { firmId: firm }))).toEqual(['Project Aster']);
    expect(await bob.as.query(api.matters.get, { matterId: walled })).toEqual({ access: 'forbidden' });
    expect(await bob.as.query(api.matters.get, { matterId: 'nope' })).toEqual({ access: 'missing' });
  });

  test('adding the lawyer to the matter grants access; a non-manager cannot change visibility', async () => {
    const { alice, bob, walled } = await world();
    await expect(bob.as.mutation(api.matters.update, { matterId: walled, visibility: 'firm' })).rejects.toThrow(/403/);
    await alice.as.mutation(api.matters.update, { matterId: walled, members: [bob.userId] });
    expect((await bob.as.query(api.matters.get, { matterId: walled })).access).toBe('ok');
  });

  test('create writes the Drive folder path, search filters, status change is audited with the actor', async () => {
    const { t, bob, firm } = await world();
    const id = await bob.as.mutation(api.matters.create, {
      firmId: firm, name: '  Quillon commercial ', number: 'M-0042', client: 'Quillon Analytics Inc.',
      parties: [{ name: 'Quillon Analytics Inc.', role: 'counterparty' }, { name: ' ', role: 'other' }], visibility: 'firm',
    });
    const m = await t.run((ctx) => ctx.db.get(id));
    expect(m).toMatchObject({ name: 'Quillon commercial', driveFolder: `/Company/Lumen/Matters/${id}`, status: 'open' });
    expect(m?.parties).toHaveLength(1);
    expect((await bob.as.query(api.matters.list, { firmId: firm, search: 'm-0042' })).map((r) => r.name)).toEqual(['Quillon commercial']);
    await bob.as.mutation(api.matters.update, { matterId: id, status: 'on_hold' });
    expect((await bob.as.query(api.matters.list, { firmId: firm, status: 'on_hold' })).map((r) => r._id)).toEqual([id]);
    const audits = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audits.find((e) => e.action === 'matter.update')).toMatchObject({ actorId: bob.userId, matterId: id, detail: 'status → on_hold' });
  });
});

describe('firms: setup and admin', () => {
  test('only the org owner creates the firm, once; it starts a trial and schedules provisioning', async () => {
    const t = lumenTest();
    const o = await org(t, 'Marrow Example');
    const owner = await signedInUser(t, 'owner@example.com');
    const lawyer = await signedInUser(t, 'lawyer@example.com');
    await addMember(t, o, owner.userId, 'owner');
    await addMember(t, o, lawyer.userId, 'member');
    const args = { orgId: o, name: 'Marrow & Finch Example LLP', practiceTags: ['M&A', ' M&A ', 'Commercial'], sizeBand: '2-10' as const };
    await expect(lawyer.as.mutation(api.firms.create, args)).rejects.toThrow(/403: only the owner/);
    const a = await owner.as.mutation(api.firms.create, args);
    expect(await owner.as.mutation(api.firms.create, args)).toBe(a);
    const firm = await owner.as.query(api.firms.forOrg, { orgId: o });
    expect(firm).toMatchObject({ plan: 'trial', seats: 5, status: 'provisioning', practiceTags: ['M&A', 'Commercial'], role: 'owner' });
    expect(firm && 'kortixProjectId' in firm).toBe(false);
  });

  test('a lawyer cannot edit the firm or read the audit log; an admin can', async () => {
    const { alice, bob, firm } = await world();
    await expect(bob.as.mutation(api.firms.update, { firmId: firm, name: 'Hijack' })).rejects.toThrow(/403: admins only/);
    await expect(bob.as.query(api.audit.list, { firmId: firm })).rejects.toThrow(/403: admins only/);
    await alice.as.mutation(api.firms.update, { firmId: firm, name: 'Example & Partners' });
    const log = await alice.as.query(api.audit.list, { firmId: firm });
    expect(log[0]).toMatchObject({ action: 'firm.update', actorId: alice.userId });
  });
});

describe('provisionFirm: project, Drive folders, the agent kit; a generic failure for the customer', () => {
  async function pending() {
    const { t, acme, alice } = await world();
    const firm = await insertFirm(t, `${acme}-2`, alice.userId, { status: 'provisioning', kortixProjectId: undefined });
    return { t, firm };
  }

  test('success settles the firm ready, provisions once per firm id and creates the Lumen folders', async () => {
    const { t, firm } = await pending();
    await t.action(internal.kortix.provisionFirm, { firmId: firm });
    expect(await t.run((ctx) => ctx.db.get(firm))).toMatchObject({ status: 'ready', kortixProjectId: 'proj_new', kortixDriveId: 'drive_1' });
    expect(kortixFake.provisions[0]).toMatchObject({
      name: 'lumen-Example - Co. Legal', starter_template: 'general-knowledge-worker', idempotency_key: `lumen-firm-${firm}`,
    });
    // arrayContaining: a firm created by an earlier test provisions on its own schedule and shares this fake.
    expect(kortixFake.folders).toEqual(expect.arrayContaining(['flag:volumes=true', '/Company', '/Company/Lumen', '/Company/Lumen/Matters', '/Company/Lumen/Runs', '/Company/Lumen/Library']));
    // The agent kit: skills + the tool CLI through one merged change request, then the four agents.
    expect(await t.run((ctx) => ctx.db.get(firm))).toMatchObject({ kitVersion: KIT.version, kitHash: KIT.hash });
    expect(kortixFake.kit.written).toContain('/workspace/skills/lumen-citations/SKILL.md');
    expect(kortixFake.kit.written).toContain('/workspace/lumen-kit/bin/lumen');
    expect(kortixFake.kit.written.some((p) => p.includes('selftest') || p.includes('fixtures'))).toBe(false);
    expect(kortixFake.kit.merged).toBeGreaterThanOrEqual(1);
    expect([...new Set(kortixFake.kit.agents)].sort()).toEqual(['lumen-counsel', 'lumen-drafter', 'lumen-extractor', 'lumen-reviewer']);
    // A second ensure is a no-op: the kit is current.
    const installs = await t.run((ctx) => ctx.db.query('kitInstalls').collect());
    expect(await t.action(internal.kitInstall.ensure, { firmId: firm })).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('kitInstalls').collect())).toHaveLength(installs.length);
  });

  test('a failure marks it failed with generic text; no member-visible row carries the raw cause', async () => {
    const { t, firm } = await pending();
    kortixFake.provision.fail = true;
    await t.action(internal.kortix.provisionFirm, { firmId: firm });
    expect(await t.run((ctx) => ctx.db.get(firm))).toMatchObject({ status: 'failed', error: 'Setup failed. Try again.' });
    const audits = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audits.find((e) => e.action === 'firm.failed')).toBeTruthy();
    expect(JSON.stringify(audits)).not.toMatch(/Kortix|exploded/);
  });
});

describe('seats', () => {
  test('members plus pending invitations may not reach the seat count', () => {
    expect(seatAvailable(5, 4, 0)).toBe(true);
    expect(seatAvailable(5, 3, 2)).toBe(false);
    expect(seatAvailable(1, 1, 0)).toBe(false);
  });

  test('seatState counts members and pending, unexpired invitations', async () => {
    const { t, acme, alice } = await world();
    const invite = (email: string, expiresAt: number) =>
      t.mutation(components.betterAuth.adapter.create, {
        input: { model: 'invitation', data: { organizationId: acme, email, role: 'member', status: 'pending', expiresAt, createdAt: Date.now(), inviterId: alice.userId } },
      } as never);
    await invite('c@example.com', Date.now() + 86_400_000);
    await invite('old@example.com', Date.now() - 1);
    expect(await t.query(internal.billing.seatState, { orgId: acme })).toEqual({ seats: 5, members: 2, pending: 1 });
  });

  test('setPlan (operator) changes plan and seats and is audited', async () => {
    const { t, firm } = await world();
    await t.mutation(internal.billing.setPlan, { firmId: firm, plan: 'team', seats: 10 });
    expect(await t.run((ctx) => ctx.db.get(firm))).toMatchObject({ plan: 'team', seats: 10 });
    await expect(t.mutation(internal.billing.setPlan, { firmId: firm, plan: 'team', seats: 0 })).rejects.toThrow(/400/);
  });
});

describe('Stripe webhook (mode A)', () => {
  const SECRET = 'whsec_test';
  async function signed(payload: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
    return `t=${t},v1=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  test('the signature check accepts a valid header and rejects a wrong secret or an old timestamp', async () => {
    const body = '{"id":"evt_1"}';
    expect(await verifyStripeSignature(body, await signed(body), SECRET)).toBe(true);
    expect(await verifyStripeSignature(body, await signed(body, 'other'), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, await signed(body, SECRET, 1000), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, '', SECRET)).toBe(false);
  });

  test('a subscription update sets plan and seats once per event id; a bad signature is a 400', async () => {
    const { t, firm } = await world();
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_PRICE_TEAM = 'price_team';
    try {
      const event = {
        id: 'evt_sub_1',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { firmId: firm }, items: { data: [{ price: { id: 'price_team' }, quantity: 12 }] } } },
      };
      const body = JSON.stringify(event);
      const post = async (sig: string) => t.fetch('/stripe/webhook', { method: 'POST', body, headers: { 'stripe-signature': sig } });
      expect((await post('t=1,v1=00')).status).toBe(400);
      const first = await post(await signed(body));
      expect(await first.json()).toEqual({ result: 'applied' });
      expect(await (await post(await signed(body))).json()).toEqual({ result: 'duplicate' });
      expect(await t.run((ctx) => ctx.db.get(firm))).toMatchObject({
        plan: 'team', seats: 12, billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
      });
    } finally {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_PRICE_TEAM;
    }
  });

  test('billing.summary reports mode "off" without STRIPE_SECRET_KEY', async () => {
    const { bob, firm } = await world();
    expect(await bob.as.query(api.billing.summary, { firmId: firm })).toMatchObject({ mode: 'off', plan: 'trial', seats: 5, used: 2 });
  });
});

describe('threads through the proxy', () => {
  const rec = (matterId: Id<'matters'>, kortixSessionId: string, title: string, proxySecret = PROXY_SECRET) =>
    ({ matterId, kortixSessionId, title, proxySecret });

  test('recording the same session twice keeps one thread and one audit event, in the matter', async () => {
    const { t, alice, matter } = await world();
    const a = await alice.as.mutation(api.threads.recordFromProxy, rec(matter, 'sess_1', '  Q3   '));
    expect(await alice.as.mutation(api.threads.recordFromProxy, rec(matter, 'sess_1', 'other'))).toBe(a);
    const threads = await t.run((ctx) => ctx.db.query('threads').collect());
    expect(threads.map((th) => [th.kortixSessionId, th.title, th.matterId])).toEqual([['sess_1', 'Q3', matter]]);
    expect((await t.run((ctx) => ctx.db.query('auditEvents').collect())).filter((e) => e.action === 'thread.create')).toHaveLength(1);
    expect(await alice.as.query(api.threads.bySession, { kortixSessionId: 'sess_1' })).toEqual({ threadId: a, matterId: matter });
  });

  test('a non-member, a lawyer off a restricted matter, or a wrong secret cannot record a thread', async () => {
    const { alice, bob, mallory, matter, walled } = await world();
    await expect(mallory.as.mutation(api.threads.recordFromProxy, rec(matter, 's2', 'x'))).rejects.toThrow(/403: not a member/);
    await expect(bob.as.mutation(api.threads.recordFromProxy, rec(walled, 's2', 'x'))).rejects.toThrow(/403: no access/);
    await expect(alice.as.mutation(api.threads.recordFromProxy, rec(matter, 's2', 'x', 'nope'))).rejects.toThrow(/403: proxy only/);
  });

  test('rename follows the session name; another matter changes nothing', async () => {
    const { t, alice, matter, walled } = await world();
    await alice.as.mutation(api.threads.recordFromProxy, rec(matter, 'sess_r', 'old'));
    await alice.as.mutation(api.threads.renameFromProxy, rec(walled, 'sess_r', 'wrong'));
    await alice.as.mutation(api.threads.renameFromProxy, rec(matter, 'sess_r', '   '));
    expect((await t.run((ctx) => ctx.db.query('threads').collect())).map((th) => th.title)).toEqual(['old']);
    await alice.as.mutation(api.threads.renameFromProxy, rec(matter, 'sess_r', '  Q3 plan '));
    expect((await t.run((ctx) => ctx.db.query('threads').collect())).map((th) => th.title)).toEqual(['Q3 plan']);
  });

  test('only the creator or an admin deletes a thread', async () => {
    const { t, acme, alice, bob, matter } = await world();
    const carol = await signedInUser(t, 'carol@example.com');
    await addMember(t, acme, carol.userId, 'member');
    await bob.as.mutation(api.threads.recordFromProxy, rec(matter, 'sess_b', 'b'));
    await bob.as.mutation(api.threads.recordFromProxy, rec(matter, 'sess_b2', 'b2'));
    const del = (kortixSessionId: string, remove: boolean) => ({ matterId: matter, kortixSessionId, proxySecret: PROXY_SECRET, remove });
    await expect(carol.as.mutation(api.threads.deleteFromProxy, del('sess_b', true))).rejects.toThrow(/403: only the thread's creator/);
    await expect(bob.as.mutation(api.threads.deleteFromProxy, del('sess_none', false))).rejects.toThrow(/404/);
    await bob.as.mutation(api.threads.deleteFromProxy, del('sess_b', true));
    await alice.as.mutation(api.threads.deleteFromProxy, del('sess_b2', true));
    expect(await t.run((ctx) => ctx.db.query('threads').collect())).toHaveLength(0);
    const audits = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audits.filter((e) => e.action === 'thread.delete').map((e) => [e.actorId, e.detail])).toEqual([
      [bob.userId, 'b'],
      [alice.userId, 'b2'],
    ]);
  });
});

describe('vault reads: search, preview, citation check, delete', () => {
  /** One ready document in `matter`, with two anchored paragraphs on page 3. */
  async function withDoc(t: T, firm: Id<'firms'>, matter: Id<'matters'>, uploadedBy: string) {
    return t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(['x'], { type: 'application/pdf' }));
      const documentId = await ctx.db.insert('documents', {
        firmId: firm, matterId: matter, storageId, filename: 'msa.pdf', mime: 'application/pdf', bytes: 1, status: 'ready', pages: 3, paras: 2,
        uploadedBy, driveFile: '/Company/Lumen/Matters/x/Docs/msa.pdf', textFile: '/Company/Lumen/Matters/x/Text/msa.md',
      });
      const p1 = '12.1 Neither party’s liability under this Agreement shall be limited.';
      const p2 = '12.2 Each party shall indemnify the other against third-party claims.';
      await ctx.db.insert('documentPages', { documentId, matterId: matter, page: 3, text: `${p1}\n\n${p2}` });
      await ctx.db.insert('documentParas', { documentId, matterId: matter, page: 3, para: 1, text: p1 });
      await ctx.db.insert('documentParas', { documentId, matterId: matter, page: 3, para: 2, text: p2 });
      return documentId;
    });
  }

  test('search finds the page with a snippet; a lawyer off a restricted matter gets null', async () => {
    const { t, alice, bob, firm, matter, walled } = await world();
    const doc = await withDoc(t, firm, matter, alice.userId);
    const hits = await bob.as.query(api.documents.search, { matterId: matter, q: 'indemnify' });
    expect(hits).toEqual([{ documentId: doc, filename: 'msa.pdf', page: 3, snippet: expect.stringContaining('indemnify') }]);
    expect(await bob.as.query(api.documents.search, { matterId: walled, q: 'indemnify' })).toBeNull();
  });

  test('detail and bytes return the anchored paragraphs and the original, only to someone who sees the matter', async () => {
    const { t, alice, mallory, firm, matter } = await world();
    const doc = await withDoc(t, firm, matter, alice.userId);
    const d = await alice.as.query(api.documents.detail, { documentId: doc });
    expect(new TextDecoder().decode(await alice.as.action(api.documents.bytes, { documentId: doc }))).toBe('x');
    await expect(mallory.as.action(api.documents.bytes, { documentId: doc })).rejects.toThrow(/403/);
    expect(d?.paras.map((p) => `p${p.page}.${p.para}`)).toEqual(['p3.1', 'p3.2']);
    expect(await mallory.as.query(api.documents.detail, { documentId: doc })).toBeNull();
    expect(await alice.as.query(api.documents.detail, { documentId: 'not-an-id' })).toBeNull();
  });

  test('citations.resolve: verified, relocated, unverified, and a document from another matter', async () => {
    const { t, alice, firm, matter, walled } = await world();
    const doc = await withDoc(t, firm, matter, alice.userId);
    const other = await withDoc(t, firm, walled, alice.userId);
    const r = await alice.as.query(api.citations.resolve, {
      matterId: matter,
      cites: [
        { d: doc, a: 'p3.1', q: "Neither party's liability" },
        { d: doc, a: 'p3.1', q: 'shall indemnify the other' },
        { d: doc, a: 'p3.2', q: 'liability is capped at fees paid' },
        { d: other, a: 'p3.1', q: 'Neither party' },
      ],
    });
    expect(r?.map((c) => [c.status, c.a])).toEqual([['verified', 'p3.1'], ['relocated', 'p3.2'], ['unverified', 'p3.2'], ['unverified', 'p3.1']]);
    expect(r?.[3].documentId).toBeNull();
  });

  test('remove deletes the rows and blob, writes document.delete, and schedules the Drive cleanup', async () => {
    const { t, alice, bob, firm, matter } = await world();
    await t.run((ctx) => ctx.db.patch(firm, { kortixDriveId: 'drive_1' }));
    const doc = await withDoc(t, firm, matter, alice.userId);
    await bob.as.mutation(api.documents.remove, { documentId: doc });
    const left = await t.run(async (ctx) => [
      await ctx.db.get(doc),
      (await ctx.db.query('documentParas').collect()).length,
      (await ctx.db.query('documentPages').collect()).length,
    ]);
    expect(left).toEqual([null, 0, 0]);
    const audits = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audits.filter((e) => e.action === 'document.delete').map((e) => [e.actorId, e.detail])).toEqual([[bob.userId, 'msa.pdf']]);
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.map((j) => j.name)).toContain('ingest:removeFromDrive');
  });
});
