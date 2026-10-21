import { beforeEach, describe, expect, test, vi } from 'vitest';
import { api, components, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { verifyStripeSignature } from '../../convex/billing';
import { KIT } from '../../convex/kit/bundle.generated';
import { seatAvailable } from '../../convex/seats';
import { PROXY_SECRET, addMember, lumenTest, org, signedInUser } from './setup';

// The Kortix SDK, faked at the module edge: every project, folder, grant, agent,
// upload and service account Lumen asks for is recorded.
// (Vitest cannot load the SDK's TypeScript source graph; Convex bundles it with esbuild.)
const kortixFake = vi.hoisted(() => {
  const calls = {
    provisions: [] as Array<Record<string, unknown>>,
    folders: [] as string[],
    flags: [] as string[],
    unshared: [] as string[],
    grants: [] as Array<{ path: string; principalType: string; principalId?: string; level: string }>,
    agents: [] as Array<{ name: string; block: Record<string, unknown> }>,
    defaults: [] as string[],
    uploads: [] as string[],
    serviceAccounts: [] as Array<{ name: string }>,
    deletedServiceAccounts: [] as string[],
    assignments: [] as Array<Record<string, unknown>>,
  };
  return {
    calls,
    provision: { fail: false },
    existingServiceAccounts: [] as Array<{ name: string; service_account_id: string }>,
    client: {
      projects: {
        provision: async (input: Record<string, unknown>) => {
          calls.provisions.push(input);
          // A 4xx: withRetry does not retry it, so the test does not wait out the backoff.
          if (kortixFake.provision.fail) throw Object.assign(new Error('422: Kortix upstream exploded at 10.0.0.7'), { status: 422 });
          return { project_id: 'proj_shared' };
        },
      },
    },
  };
});
vi.mock('@kortix/sdk/server', () => ({
  createScopedKortix: () => kortixFake.client,
  runWithKortix: (_config: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@kortix/sdk', () => {
  const c = kortixFake.calls;
  return {
    getProject: async () => ({ project_id: 'proj_shared', account_id: 'acc_operator' }),
    getProjectDrive: async () => ({ driveId: 'drive_shared' }),
    getProjectDetail: async () => ({ config: { agents: [{ name: 'kortix', enabled: true, scope: { kortix_permissions: 'all' } }, { name: 'lumen-none', enabled: true }] } }),
    updateFeatureFlag: async (_p: string, key: string, on: boolean) => void c.flags.push(`${key}=${on}`),
    getFolderAccess: async (_d: string, path: string) => ({
      grants: path === '/Company' ? [{ grantId: 'g_company', principalType: 'project', inherited: false, system: true }] : [],
    }),
    unshareFolder: async (_d: string, grantId: string) => void c.unshared.push(grantId),
    makeDriveFolder: async (_d: string, path: string) => void c.folders.push(path),
    shareFolder: async (_d: string, input: { path: string; principalType: string; principalId?: string; level: string }) => {
      c.grants.push(input);
      return { grantId: `g_${c.grants.length}` };
    },
    updateAgentConfig: async (_p: string, name: string, block: Record<string, unknown>) => void c.agents.push({ name, block }),
    updateProjectDefaultAgent: async (_p: string, name: string) => void c.defaults.push(name),
    uploadDriveFile: async (_d: string, path: string) => void c.uploads.push(path),
    listServiceAccountsApi: async () => kortixFake.existingServiceAccounts,
    deleteServiceAccountApi: async (_a: string, id: string) => void c.deletedServiceAccounts.push(id),
    createServiceAccountApi: async (_a: string, input: { name: string }) => {
      c.serviceAccounts.push(input);
      return { service_account_id: `sa_${c.serviceAccounts.length}`, name: input.name, secret: `kortix_sa_secret_${c.serviceAccounts.length}` };
    },
    createAssignment: async (_a: string, input: Record<string, unknown>) => void c.assignments.push(input),
    createProjectSession: async () => ({ session_id: 'sess_new' }),
  };
});
beforeEach(() => {
  for (const list of Object.values(kortixFake.calls)) list.length = 0;
  kortixFake.provision.fail = false;
  kortixFake.existingServiceAccounts.length = 0;
});

type T = ReturnType<typeof lumenTest>;

/** The shared project, ready with this code's kit (what `kortix:ensure` leaves behind). */
async function readyDeployment(t: T) {
  await t.run(async (ctx) => {
    if (await ctx.db.query('deployment').first()) return;
    await ctx.db.insert('deployment', {
      key: 'default', status: 'ready', projectId: 'proj_shared', accountId: 'acc_operator', driveId: 'drive_shared',
      kitVersion: KIT.version, kitHash: KIT.hash,
    });
  });
}

/** An onboarded firm: its agent and its service-account secret, in the shared project. */
async function insertFirm(t: T, orgId: string, createdBy: string, patch: Record<string, unknown> = {}) {
  await readyDeployment(t);
  return t.run(async (ctx) => {
    const firmId = await ctx.db.insert('firms', {
      orgId, name: 'Example & Co. Legal', practiceTags: [], sizeBand: '2-10', status: 'ready',
      plan: 'trial', seats: 5, billingStatus: 'none', createdBy, ...patch,
    });
    if ((patch.status ?? 'ready') === 'ready') {
      await ctx.db.patch(firmId, { kortixAgent: `lumen-f-${firmId}`, agentConfig: `${KIT.hash}:`, kortixServiceAccountId: `sa_${firmId}` });
      await ctx.db.insert('firmCredentials', { firmId, serviceAccountId: `sa_${firmId}`, secret: `kortix_sa_secret_${firmId}` });
    }
    return firmId;
  });
}

async function insertMatter(t: T, firmId: Id<'firms'>, createdBy: string, visibility: 'firm' | 'restricted' = 'firm') {
  return t.run((ctx) =>
    ctx.db.insert('matters', {
      firmId, name: visibility === 'firm' ? 'Project Aster' : 'Walled', client: 'Brightwater Example Holdings', parties: [],
      status: 'open', visibility, driveFolder: `/Lumen/Firms/${firmId}/Matters/x`, createdBy, updatedAt: Date.now(),
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

describe('memberToken: which firm credential the proxy gets for which matter', () => {
  test('a member gets the firm service-account secret, the shared project and the firm agent; nothing is minted', async () => {
    const { alice, firm, matter } = await world();
    const got = await token(alice.as, matter);
    expect(got).toMatchObject({ token: `kortix_sa_secret_${firm}`, projectId: 'proj_shared', agent: `lumen-f-${firm}`, firmId: firm, userId: alice.userId });
    expect(got.expiresAt).toBeGreaterThan(Date.now());
    expect(kortixFake.calls.serviceAccounts).toHaveLength(0);
  });

  test('two firms in the one project get two credentials and two agents; a member of one never gets the other', async () => {
    const { t, alice, mallory, firm, matter } = await world();
    const other = await org(t, 'Other Example');
    await addMember(t, other, mallory.userId, 'owner');
    const firmB = await insertFirm(t, other, mallory.userId);
    const matterB = await insertMatter(t, firmB, mallory.userId);
    const a = await token(alice.as, matter);
    const b = await token(mallory.as, matterB);
    expect(a.projectId).toBe(b.projectId);
    expect([a.token, a.agent]).toEqual([`kortix_sa_secret_${firm}`, `lumen-f-${firm}`]);
    expect([b.token, b.agent]).toEqual([`kortix_sa_secret_${firmB}`, `lumen-f-${firmB}`]);
    await expect(token(alice.as, matterB)).rejects.toThrow(/403: not a member/);
    await expect(token(mallory.as, matter)).rejects.toThrow(/403: not a member/);
  });

  test('refused: a non-member, a lawyer on a restricted matter, a provisioning firm, an unknown id, a wrong secret', async () => {
    const { t, acme, alice, bob, mallory, matter, walled } = await world();
    const pending = await insertFirm(t, acme, alice.userId, { status: 'provisioning', orgId: 'other' });
    const pendingMatter = await insertMatter(t, pending, alice.userId);
    await expect(token(mallory.as, matter)).rejects.toThrow(/403: not a member/);
    await expect(token(bob.as, walled)).rejects.toThrow(/403: no access to this matter/);
    await expect(token(alice.as, pendingMatter)).rejects.toThrow(/403|409/);
    await expect(token(alice.as, 'not-a-matter-id')).rejects.toThrow(/404: /);
    await expect(token(alice.as, matter, 'wrong')).rejects.toThrow(/403: proxy only/);
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

  test('firm history and matter counts: a lawyer never sees a run on a restricted matter', async () => {
    const { t, alice, bob, mallory, firm, matter, walled } = await world();
    for (const [m, title] of [[matter, 'Open review'], [walled, 'Walled review']] as const) {
      await t.run((ctx) => ctx.db.insert('runs', {
        firmId: firm, matterId: m, kind: 'review', title, status: 'succeeded', documentIds: [], createdBy: alice.userId,
      }));
    }
    const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();
    expect(titles(await alice.as.query(api.workflows.firmHistory, { firmId: firm }))).toEqual(['Open review', 'Walled review']);
    expect(titles(await bob.as.query(api.workflows.firmHistory, { firmId: firm }))).toEqual(['Open review']);
    await expect(mallory.as.query(api.workflows.firmHistory, { firmId: firm })).rejects.toThrow();
    const [row] = await bob.as.query(api.matters.list, { firmId: firm });
    expect([row!.runCount, row!.documentCount]).toEqual([1, 0]);
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
    expect(m).toMatchObject({ name: 'Quillon commercial', driveFolder: `/Lumen/Firms/${firm}/Matters/${id}`, status: 'open' });
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
    expect(firm && ('kortixAgent' in firm || 'kortixServiceAccountId' in firm)).toBe(false);
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

describe('provisionFirm: one shared project, one folder + agent + service account per firm', () => {
  async function pending(t: T, orgId: string, createdBy: string) {
    return insertFirmRow(t, orgId, createdBy);
  }
  /** A firm row before onboarding (no deployment, no agent, no credential). */
  const insertFirmRow = (t: T, orgId: string, createdBy: string) =>
    t.run((ctx) => ctx.db.insert('firms', {
      orgId, name: 'Example & Co. Legal', practiceTags: [], sizeBand: '2-10', status: 'provisioning',
      plan: 'trial', seats: 5, billingStatus: 'none', createdBy,
    }));

  test('the first firm bootstraps the project once: Files on, /Company unshared, kit uploaded, starter agents locked', async () => {
    const t = lumenTest();
    const firm = await pending(t, 'org_1', 'user_1');
    await t.action(internal.kortix.provisionFirm, { firmId: firm });
    const c = kortixFake.calls;
    expect(c.provisions).toEqual([{ name: 'lumen', idempotency_key: 'lumen-deployment' }]);
    expect(c.flags).toContain('volumes=true');
    expect(c.unshared).toEqual(['g_company']);
    expect(c.folders).toEqual(expect.arrayContaining(['/Lumen', '/Lumen/Kit', '/Lumen/Firms']));
    expect(c.uploads).toContain(`/Lumen/Kit/${KIT.version}/agents/lumen-extractor.md`);
    expect(c.uploads).toContain(`/Lumen/Kit/${KIT.version}/lumen-kit/bin/lumen`);
    expect(c.uploads).toContain(`/Lumen/Kit/${KIT.version}/skills/lumen-citations/SKILL.md`);
    expect(c.uploads.at(-1) === '/Lumen/Kit/CURRENT' || c.uploads.includes('/Lumen/Kit/CURRENT')).toBe(true);
    expect(c.defaults).toEqual(['lumen-none']);
    expect(c.agents.find((a) => a.name === 'lumen-none')?.block).toMatchObject({ kortix_permissions: 'none', repository_access: false });
    expect(c.agents.find((a) => a.name === 'kortix')?.block).toMatchObject({ enabled: false, kortix_permissions: 'none', repository_access: false });
    expect(await t.run((ctx) => ctx.db.query('deployment').collect())).toMatchObject([
      { status: 'ready', projectId: 'proj_shared', accountId: 'acc_operator', driveId: 'drive_shared', kitVersion: KIT.version, kitHash: KIT.hash },
    ]);
  });

  test('a firm gets its folders, an agent with exactly two grants and no repository, and a member service account', async () => {
    const t = lumenTest();
    const firm = await pending(t, 'org_1', 'user_1');
    await t.action(internal.kortix.provisionFirm, { firmId: firm });
    const c = kortixFake.calls;
    const agent = `lumen-f-${firm}`;
    expect(c.folders).toEqual(expect.arrayContaining([`/Lumen/Firms/${firm}`, `/Lumen/Firms/${firm}/Matters`, `/Lumen/Firms/${firm}/Runs`, `/Lumen/Firms/${firm}/Library`]));
    expect(c.agents.find((a) => a.name === agent)?.block).toMatchObject({
      enabled: true, kortix_permissions: 'none', repository_access: false, behavior: { mode: 'primary', prompt: KIT.agents['lumen-counsel'] },
    });
    expect(c.grants).toEqual([
      { path: `/Lumen/Firms/${firm}`, principalType: 'agent', principalId: agent, level: 'write' },
      { path: '/Lumen/Kit', principalType: 'agent', principalId: agent, level: 'read' },
    ]);
    expect(c.serviceAccounts.map((s) => s.name)).toEqual([`lumen-firm-${firm}`]);
    expect(c.assignments).toEqual([
      { principal: { type: 'service_account', id: 'sa_1' }, roleKey: 'member', scope: { type: 'project', id: 'proj_shared' } },
      { principal: { type: 'service_account', id: 'sa_1' }, roleKey: 'agent-user', scope: { type: 'project', id: 'proj_shared' }, object: { type: 'agent', id: agent } },
    ]);
    expect(await t.run((ctx) => ctx.db.get(firm))).toMatchObject({ status: 'ready', kortixAgent: agent, kortixServiceAccountId: 'sa_1' });
    expect(await t.run((ctx) => ctx.db.query('firmCredentials').collect())).toMatchObject([{ firmId: firm, serviceAccountId: 'sa_1', secret: 'kortix_sa_secret_1' }]);
  });

  test('a second firm reuses the project and the kit: no new project, no upload, its own agent and service account', async () => {
    const t = lumenTest();
    const a = await pending(t, 'org_1', 'user_1');
    await t.action(internal.kortix.provisionFirm, { firmId: a });
    for (const list of Object.values(kortixFake.calls)) list.length = 0;
    const b = await pending(t, 'org_2', 'user_2');
    await t.action(internal.kortix.provisionFirm, { firmId: b });
    const c = kortixFake.calls;
    expect([c.provisions, c.uploads, c.unshared]).toEqual([[], [], []]);
    expect(c.agents.map((x) => x.name)).toEqual([`lumen-f-${b}`]);
    expect(c.grants.map((g) => g.principalId)).toEqual([`lumen-f-${b}`, `lumen-f-${b}`]);
    expect(c.serviceAccounts.map((s) => s.name)).toEqual([`lumen-firm-${b}`]);
  });

  test('a retry after a lost secret deletes the orphan service account and creates a fresh one', async () => {
    const t = lumenTest();
    const firm = await pending(t, 'org_1', 'user_1');
    kortixFake.existingServiceAccounts.push({ name: `lumen-firm-${firm}`, service_account_id: 'sa_orphan' });
    await t.action(internal.kortix.provisionFirm, { firmId: firm });
    expect(kortixFake.calls.deletedServiceAccounts).toEqual(['sa_orphan']);
    expect(kortixFake.calls.serviceAccounts).toHaveLength(1);
  });

  test('a failure marks it failed with generic text; no member-visible row carries the raw cause', async () => {
    const t = lumenTest();
    const firm = await pending(t, 'org_1', 'user_1');
    kortixFake.provision.fail = true;
    await t.action(internal.kortix.provisionFirm, { firmId: firm }).catch(() => undefined);
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
        uploadedBy, driveFile: `/Lumen/Firms/${firm}/Matters/x/Docs/msa.pdf`, textFile: `/Lumen/Firms/${firm}/Matters/x/Text/msa.md`,
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

  test('search leaves out an earlier version: its old text never shows under the current name', async () => {
    const { t, alice, bob, firm, matter } = await world();
    const v1 = await withDoc(t, firm, matter, alice.userId);
    await t.run((ctx) => ctx.db.patch(v1, { superseded: true }));
    expect(await bob.as.query(api.documents.search, { matterId: matter, q: 'indemnify' })).toEqual([]);
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

describe('vault upload during provisioning', () => {
  test('ingest waits for the firm Drive instead of failing the document', async () => {
    const { t, alice, matter } = await world();
    // The shared project is still being created: no Drive yet.
    await t.run(async (ctx) => ctx.db.delete((await ctx.db.query('deployment').first())!._id));
    const bytes = new TextEncoder().encode('MUTUAL NDA between two example parties.').buffer as ArrayBuffer;
    const documentId = await alice.as.action(api.documents.upload, { matterId: matter, filename: 'nda.txt', bytes, contentType: 'text/plain' });
    await t.action(internal.ingest.ingest, { documentId });
    const doc = await t.run((ctx) => ctx.db.get(documentId));
    expect([doc?.status, doc?.error]).toEqual(['extracting', undefined]);
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(jobs.filter((j) => j.name === 'ingest:ingest').map((j) => j.args[0])).toContainEqual({ documentId, attempt: 1 });
  });
});

describe('vault upload: the same bytes twice', () => {
  test('the second upload is refused before a row, a count or an audit event exists', async () => {
    const { t, alice, matter } = await world();
    const bytes = new TextEncoder().encode('MUTUAL NDA between two example parties.').buffer as ArrayBuffer;
    const args = { matterId: matter, filename: 'nda.txt', bytes, contentType: 'text/plain' };
    await alice.as.action(api.documents.upload, args);
    await expect(alice.as.action(api.documents.upload, { ...args, filename: 'nda-copy.txt' })).rejects.toThrow(/409: Already in this vault \(nda\.txt\)/);
    const rows = await t.run((ctx) => ctx.db.query('documents').collect());
    expect(rows.map((d) => d.filename)).toEqual(['nda.txt']);
    const audits = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audits.filter((a) => a.action === 'document.upload')).toHaveLength(1);
  });
});
