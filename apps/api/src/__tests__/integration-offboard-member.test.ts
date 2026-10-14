/**
 * Integration test (real local DB, real routes): offboarding ends what a
 * member left behind in the account (KRTX-1722).
 *
 * Member removal, leave and SCIM deactivation run one sequence
 * (`accounts/core/offboard-member.ts`). Before it, all three removed the
 * sign-in and the grants and left two things running on the person's identity:
 *
 * - every computer account of the account that reaches a machine the person
 *   owns stayed `active`, for a machine shared into the team account and for a
 *   personal-account machine attached to a team project;
 * - every reminder the person set kept its schedule, and paused only at its
 *   next fire.
 *
 * Each case seeds a fresh team account, offboards the member through the real
 * route, and reads the rows back. Rows of other people and of another account
 * the member stays in must not change.
 */
import { describe, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  auditEvents,
  connectorConnections,
  connectors,
  creditAccounts,
  projectTriggerRuntime,
  tunnelConnections,
} from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as realSeats from '../billing/services/seat-management';
import { insertSessionReminder, newReminderId, reminderSpec } from '../projects/lib/session-reminders';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

// The seat sync calls Stripe, and the Stripe client sets no timeout. A case
// closes the gate to hold the sync open and see which reply waits for it.
const realOnMemberRemoved = realSeats.onMemberRemoved;
const seatSyncsStarted: string[] = [];
let seatGate: Promise<void> = Promise.resolve();
mock.module('../billing/services/seat-management', () => ({
  ...realSeats,
  onMemberRemoved: async (accountId: string, userId: string) => {
    seatSyncsStarted.push(userId);
    await seatGate;
    return realOnMemberRemoved(accountId, userId);
  },
}));

const { app } = await import('../index');
const { attachComputerConnection } = await import('../connectors/computers');
const { createAccountToken } = await import('../repositories/account-tokens');
const { createScimToken } = await import('../repositories/scim');
const { saveDirectoryUser } = await import('../scim/directory-users');

async function seedUsers(ids: string[]): Promise<void> {
  await db.execute(sql`
    INSERT INTO auth.users (id, email, instance_id, aud, role)
    VALUES ${sql.join(
      ids.map((id) => sql`(${id}::uuid, ${`offboard-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`),
      sql`, `,
    )}`);
}

async function computerConnector(project: SeededProject): Promise<string> {
  const [row] = await db
    .insert(connectors)
    .values({
      projectId: project.project_id,
      accountId: project.account_id,
      slug: 'computer',
      name: 'Computers',
      providerType: 'computer',
    })
    .returning({ connectorId: connectors.connectorId });
  return row!.connectorId;
}

/** A paired machine. `accountId` is where it lives: a team account, or the owner's personal account. */
async function machine(accountId: string, ownerUserId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(tunnelConnections)
    .values({ accountId, ownerUserId, name })
    .returning({ tunnelId: tunnelConnections.tunnelId });
  return row!.tunnelId;
}

/** A computer account on `project`'s computer connector. */
async function computerAccount(
  project: SeededProject,
  connectorId: string,
  input: { ownerId: string | null; tunnelId: string; label: string },
): Promise<string> {
  const [row] = await db
    .insert(connectorConnections)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      connectorId,
      ownerType: input.ownerId ? 'member' : 'project',
      ownerId: input.ownerId,
      label: input.label,
      status: 'active',
      isDefault: true,
      tunnelId: input.tunnelId,
    })
    .returning({ connectionId: connectorConnections.connectionId });
  return row!.connectionId;
}

/** An hourly reminder on `sessionId`. `author` null: the session's agent set it. */
async function reminder(project: SeededProject, sessionId: string, createdBy: string, author: string | null): Promise<string> {
  const now = new Date();
  const draft = {
    prompt: 'Check in on the vendor.',
    name: null,
    everySeconds: 3600,
    cron: null,
    timezone: 'UTC',
    firstFireAt: new Date(now.getTime() + 3_600_000),
  };
  const spec = reminderSpec({ id: newReminderId(), sessionId, agent: 'default', draft, now, promptAuthorUserId: author });
  const row = await insertSessionReminder({
    projectId: project.project_id,
    spec,
    createdBy,
    firstFireAt: draft.firstFireAt,
    now,
  });
  return row.slug;
}

async function bearer(accountId: string, userId: string): Promise<string> {
  const token = await createAccountToken({ accountId, userId, name: `offboard-${crypto.randomUUID()}`, agentGrant: null });
  return token.secretKey;
}

/**
 * A team account with an owner, the member who leaves, and a peer who stays.
 * The member is also in a second account, which offboarding must not touch.
 */
async function seedWorld(label: string) {
  const owner = crypto.randomUUID();
  const member = crypto.randomUUID();
  const peer = crypto.randomUUID();
  const project = await seedProject(label);
  const elsewhere = await seedProject(`${label}-elsewhere`);
  const team = project.account_id;
  await seedUsers([owner, member, peer]);
  // SCIM needs the Enterprise `scim` entitlement.
  await db.insert(creditAccounts).values({ accountId: team, demoEnterprise: true });
  await insertIntoView(db, accountMembers, [
    { accountId: team, userId: owner, accountRole: 'owner' },
    { accountId: team, userId: member, accountRole: 'member' },
    { accountId: team, userId: peer, accountRole: 'member' },
    { accountId: elsewhere.account_id, userId: member, accountRole: 'owner' },
  ]);

  const connector = await computerConnector(project);
  const elsewhereConnector = await computerConnector(elsewhere);
  // Shared with the project at pairing: the machine joins the team account.
  const teamMachine = await machine(team, member, 'Studio');
  // A private pairing: the machine lives in the member's personal account
  // (id = user id) and reaches the team project through a member account.
  const personalMachine = await machine(member, member, 'Laptop');
  const peerMachine = await machine(team, peer, 'Peer laptop');
  const computers = {
    teamMachine: await computerAccount(project, connector, { ownerId: null, tunnelId: teamMachine, label: 'Studio' }),
    personalMachine: await computerAccount(project, connector, { ownerId: member, tunnelId: personalMachine, label: 'Laptop' }),
    peerMachine: await computerAccount(project, connector, { ownerId: peer, tunnelId: peerMachine, label: 'Peer laptop' }),
    elsewhere: await computerAccount(elsewhere, elsewhereConnector, { ownerId: member, tunnelId: personalMachine, label: 'Laptop' }),
  };

  const session = await seedSession(project, member);
  const elsewhereSession = await seedSession(elsewhere, member);
  const reminders = {
    authored: await reminder(project, session, member, member),
    peer: await reminder(project, session, peer, peer),
    // An agent's reminder fires as the session's agent, not as the member.
    agent: await reminder(project, session, member, null),
    elsewhere: await reminder(elsewhere, elsewhereSession, member, member),
  };
  return { team, owner, member, peer, project, elsewhere, computers, reminders };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

async function connectionRows(world: World) {
  const rows = await db
    .select({
      connectionId: connectorConnections.connectionId,
      status: connectorConnections.status,
      isDefault: connectorConnections.isDefault,
      metadata: connectorConnections.metadata,
    })
    .from(connectorConnections)
    .where(inArray(connectorConnections.connectionId, Object.values(world.computers)));
  return new Map(rows.map((row) => [row.connectionId, row]));
}

async function reminderEnabled(world: World): Promise<Map<string, boolean>> {
  const rows = await db
    .select({ slug: projectTriggerRuntime.slug, enabled: projectTriggerRuntime.enabled, nextFireAt: projectTriggerRuntime.nextFireAt })
    .from(projectTriggerRuntime)
    .where(inArray(projectTriggerRuntime.slug, Object.values(world.reminders)));
  return new Map(rows.map((row) => [row.slug, row.enabled === true && row.nextFireAt !== null]));
}

async function offboardingEvents(world: World) {
  return db
    .select({ actorUserId: auditEvents.actorUserId, resourceId: auditEvents.resourceId, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(and(eq(auditEvents.accountId, world.team), eq(auditEvents.action, 'member.offboarded')));
}

/** What every exit path must leave behind. */
async function expectOffboarded(world: World, reason: string, actorUserId: string | null): Promise<void> {
  const computers = await connectionRows(world);
  for (const id of [world.computers.teamMachine, world.computers.personalMachine]) {
    expect(computers.get(id)).toMatchObject({ status: 'revoked', isDefault: false, metadata: { revokedReason: 'owner_left' } });
  }
  // A peer's machine, and the member's account in an account they stay in.
  for (const id of [world.computers.peerMachine, world.computers.elsewhere]) {
    expect(computers.get(id)).toMatchObject({ status: 'active', isDefault: true });
    expect(computers.get(id)?.metadata).not.toHaveProperty('revokedReason');
  }

  const reminders = await reminderEnabled(world);
  expect(reminders.get(world.reminders.authored)).toBe(false);
  expect(reminders.get(world.reminders.peer)).toBe(true);
  expect(reminders.get(world.reminders.agent)).toBe(true);
  expect(reminders.get(world.reminders.elsewhere)).toBe(true);

  expect(await offboardingEvents(world)).toEqual([
    {
      actorUserId,
      resourceId: world.member,
      metadata: expect.objectContaining({ reason, computers_revoked: 2, reminders_disabled: 1 }),
    },
  ]);

  const [membership] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM kortix.account_memberships
    WHERE account_id = ${world.team}::uuid AND user_id = ${world.member}::uuid`);
  expect(Number(membership?.n)).toBe(0);
}

describe('offboarding ends what the member left behind', () => {
  test('an owner removes the member', async () => {
    const world = await seedWorld('offboard-remove');
    const res = await app.request(`/v1/accounts/${world.team}/members/${world.member}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await bearer(world.team, world.owner)}` },
    });
    expect(res.status).toBe(200);
    await expectOffboarded(world, 'removed', world.owner);
  });

  test('the member leaves', async () => {
    const world = await seedWorld('offboard-leave');
    const res = await app.request(`/v1/accounts/${world.team}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await bearer(world.team, world.member)}` },
    });
    expect(res.status).toBe(200);
    await expectOffboarded(world, 'left', world.member);
  });

  test('the identity provider deactivates the member over SCIM', async () => {
    const world = await seedWorld('offboard-scim');
    const res = await scimDeactivate(world);
    expect(res.status).toBe(200);
    await expectOffboarded(world, 'deprovisioned', null);
  });
});

/** The IdP deactivates the member it provisioned. */
async function scimDeactivate(world: World): Promise<Response> {
  const { secret } = await createScimToken({ accountId: world.team, name: 'offboard-scim', createdBy: world.owner });
  // The IdP provisioned the member, so the directory row exists. Without it
  // SCIM looks the email up in Supabase Auth, which this lane does not run.
  await saveDirectoryUser({
    accountId: world.team,
    scimId: world.member,
    userId: world.member,
    userName: `offboard-${world.member.slice(0, 8)}@example.test`,
  });
  return app.request(`/scim/v2/accounts/${world.team}/Users/${world.member}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/scim+json' },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: false } }],
    }),
  });
}

/** Closes the seat-sync gate. Call the returned function to open it. */
function holdSeatSync(): () => void {
  let open!: () => void;
  seatGate = new Promise<void>((resolve) => (open = resolve));
  return () => {
    open();
    seatGate = Promise.resolve();
  };
}

/** The reply's status, or 'waiting' when it has not come within `ms`. */
const replyWithin = (reply: Response | Promise<Response>, ms: number) =>
  Promise.race([Promise.resolve(reply).then((res) => res.status), Bun.sleep(ms).then(() => 'waiting' as const)]);

// A non-streaming request has 25 s (middleware/request-deadline.ts), and a
// stalled Stripe call can take 80 s (stripe-node's default timeout). A person
// who removes or leaves must not get a 503 for a removal that already happened.
describe('the seat sync and the reply', () => {
  test('remove and leave answer while the seat sync is still running', async () => {
    const world = await seedWorld('offboard-seat-stall');
    const open = holdSeatSync();
    try {
      const removed = app.request(`/v1/accounts/${world.team}/members/${world.member}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await bearer(world.team, world.owner)}` },
      });
      expect(await replyWithin(removed, 2_000)).toBe(200);
      const left = app.request(`/v1/accounts/${world.team}/leave`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await bearer(world.team, world.peer)}` },
      });
      expect(await replyWithin(left, 2_000)).toBe(200);
      // Both syncs started: the seat is released, only not before the reply.
      expect(seatSyncsStarted).toEqual(expect.arrayContaining([world.member, world.peer]));
    } finally {
      open();
    }
  });

  test('SCIM deactivation answers after the seat sync settles', async () => {
    const world = await seedWorld('offboard-seat-scim');
    const open = holdSeatSync();
    try {
      const reply = scimDeactivate(world);
      while (!seatSyncsStarted.includes(world.member)) await Bun.sleep(10);
      expect(await replyWithin(reply, 200)).toBe('waiting');
      open();
      expect((await reply).status).toBe(200);
    } finally {
      open();
    }
  });
});

// Offboarding marks a computer account `revokedReason: owner_left`. Once the
// account is active again, the reason is no longer true.
describe('a revoked computer account that comes back', () => {
  test('re-pairing the same machine clears revokedReason', async () => {
    const world = await seedWorld('offboard-repair');
    const res = await app.request(`/v1/accounts/${world.team}/members/${world.member}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await bearer(world.team, world.owner)}` },
    });
    expect(res.status).toBe(200);
    const [revoked] = await db
      .select()
      .from(connectorConnections)
      .where(eq(connectorConnections.connectionId, world.computers.personalMachine));
    expect(revoked).toMatchObject({ status: 'revoked', metadata: { revokedReason: 'owner_left' } });

    const reattached = await db.transaction((tx) =>
      attachComputerConnection(tx, {
        accountId: world.team,
        projectId: world.project.project_id,
        connectorId: revoked!.connectorId,
        ownerType: 'member',
        ownerId: world.member,
        tunnelId: revoked!.tunnelId!,
        name: 'Laptop',
        createdBy: world.member,
      }),
    );
    expect(reattached).toMatchObject({ created: false, connection: { connectionId: world.computers.personalMachine } });
    const computers = await connectionRows(world);
    expect(computers.get(world.computers.personalMachine)).toMatchObject({ status: 'active' });
    expect(computers.get(world.computers.personalMachine)?.metadata).not.toHaveProperty('revokedReason');
  });

  test('activating the account clears revokedReason', async () => {
    const world = await seedWorld('offboard-activate');
    const owner = await bearer(world.team, world.owner);
    const res = await app.request(`/v1/accounts/${world.team}/members/${world.member}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner}` },
    });
    expect(res.status).toBe(200);
    const activated = await app.request(
      `/v1/projects/${world.project.project_id}/connections/${world.computers.teamMachine}/activate`,
      { method: 'PUT', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(activated.status).toBe(200);
    const computers = await connectionRows(world);
    expect(computers.get(world.computers.teamMachine)).toMatchObject({ status: 'active' });
    expect(computers.get(world.computers.teamMachine)?.metadata).not.toHaveProperty('revokedReason');
  });
});
