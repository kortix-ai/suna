/**
 * Integration test (real local DB): who may still see what a notification
 * names (KRTX-1742 design §3.0, notifications/access.ts). The checks run when
 * a notification is written and again when it is read or emailed, so each row
 * of this matrix is a person who must, or must not, get a session's title and
 * the agent's question text.
 *
 * Real: account and project roles, session visibility and grants, groups,
 * the tombstone, the trigger-run manager override, account oversight.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  accounts,
  projectMembers,
  projectSessionGrants,
  projectSessions,
  serviceAccounts,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import * as authorize from '../iam/authorize';
import { clearAuthorizeCaches } from '../iam/authorize';
import { invalidateSessionOversight } from '../iam/session-oversight';
import {
  filterSessionRecipients,
  filterTriggerRecipients,
  loadSessionAccessRows,
  mayReadProjectTriggers,
  maySeeSessions,
  personsAmong,
  type SessionAccessRow,
} from '../notifications/access';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID(); // account owner, no project role
const CREATOR = crypto.randomUUID(); // project member, creates every human session
const MEMBER = crypto.randomUUID(); // project member, named in the restricted share
const GROUPED = crypto.randomUUID(); // project member, in the shared group
const PLAIN = crypto.randomUUID(); // project member, named nowhere
const MANAGER = crypto.randomUUID(); // project manager
const ACCOUNT_ONLY = crypto.randomUUID(); // account member, no project role
const LOST = crypto.randomUUID(); // project member until the test removes the role
const REMOVED = crypto.randomUUID(); // member until the test removes them from the account
const STRANGER = crypto.randomUUID(); // in no account
const SERVICE_ACCOUNT = crypto.randomUUID(); // a trigger session's creator, with a project role
const users = [OWNER, CREATOR, MEMBER, GROUPED, PLAIN, MANAGER, ACCOUNT_ONLY, LOST, REMOVED, STRANGER];
const GROUP = crypto.randomUUID();

let project: SeededProject;
const ids = {
  private: crypto.randomUUID(),
  project: crypto.randomUUID(),
  restricted: crypto.randomUUID(),
  tombstoned: crypto.randomUUID(),
  trigger: crypto.randomUUID(),
};
let rows: Map<string, SessionAccessRow>;

async function visibleTo(userId: string): Promise<string[]> {
  const seen = await maySeeSessions(userId, [...rows.values()]);
  return Object.entries(ids)
    .filter(([, id]) => seen.has(id))
    .map(([name]) => name)
    .sort();
}

beforeAll(async () => {
  project = await seedProject('notify-access');
  const user = (id: string) =>
    sql`(${id}::uuid, ${`notify-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`
    INSERT INTO auth.users (id, email, instance_id, aud, role)
    VALUES ${sql.join(users.map(user), sql`, `)}`);
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    ...[CREATOR, MEMBER, GROUPED, PLAIN, MANAGER, ACCOUNT_ONLY, LOST, REMOVED].map((userId) => ({
      userId,
      accountId: project.account_id,
      accountRole: 'member' as const,
    })),
  ]);
  await insertIntoView(db, projectMembers, [
    ...[CREATOR, MEMBER, GROUPED, PLAIN, LOST, REMOVED].map((userId) => ({
      accountId: project.account_id,
      projectId: project.project_id,
      userId,
      projectRole: 'member' as const,
    })),
    { accountId: project.account_id, projectId: project.project_id, userId: MANAGER, projectRole: 'manager' },
  ]);
  await db.insert(accountGroups).values({ groupId: GROUP, accountId: project.account_id, name: 'Reviewers' });
  await db.insert(accountGroupMembers).values({ groupId: GROUP, userId: GROUPED });

  const base = { accountId: project.account_id, projectId: project.project_id, createdBy: CREATOR };
  await db.insert(projectSessions).values([
    { ...base, sessionId: ids.private, branchName: ids.private, visibility: 'private' },
    { ...base, sessionId: ids.project, branchName: ids.project, visibility: 'project' },
    { ...base, sessionId: ids.restricted, branchName: ids.restricted, visibility: 'restricted' },
    {
      ...base,
      sessionId: ids.tombstoned,
      branchName: ids.tombstoned,
      visibility: 'project',
      metadata: { deletedAt: '2026-10-01T00:00:00.000Z' },
    },
    {
      ...base,
      createdBy: SERVICE_ACCOUNT,
      sessionId: ids.trigger,
      branchName: ids.trigger,
      visibility: 'private',
      origin: 'schedule',
      initiatorType: 'trigger',
      metadata: { trigger_kind: 'git', trigger_slug: 'nightly', source: 'trigger:cron' },
    },
  ]);
  await db.insert(projectSessionGrants).values([
    { sessionId: ids.restricted, principalType: 'member', principalId: MEMBER },
    { sessionId: ids.restricted, principalType: 'group', principalId: GROUP },
  ]);
  // A backend's service account: active, with the project member role, so the
  // IAM lets it read the project's sessions and triggers.
  await db.insert(serviceAccounts).values({
    serviceAccountId: SERVICE_ACCOUNT,
    accountId: project.account_id,
    name: 'notify-access-sa',
    secretHash: `h_${SERVICE_ACCOUNT}`,
    publicPrefix: `kortix_sa_${SERVICE_ACCOUNT.slice(0, 6)}`,
  });
  await db.execute(sql`
    INSERT INTO kortix.role_assignments (account_id, principal_type, principal_id, role_id, scope_type, scope_id)
    SELECT ${project.account_id}::uuid, 'service_account', ${SERVICE_ACCOUNT}::uuid, role_id, 'project', ${project.project_id}::uuid
      FROM kortix.roles WHERE account_id IS NULL AND scope_type = 'project' AND key = 'member'`);
  rows = await loadSessionAccessRows(Object.values(ids));
}, 30_000);

afterAll(async () => {
  if (!project) return;
  await db.delete(accountGroups).where(eq(accountGroups.groupId, GROUP));
  await removeSeeded([project]);
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join(users.map((id) => sql`${id}::uuid`), sql`, `)})`);
});

describe('maySeeSessions — the session access matrix', () => {
  test('loads every seeded session row', () => {
    expect(rows.size).toBe(5);
    expect(rows.get(ids.trigger)).toMatchObject({ createdBy: SERVICE_ACCOUNT, origin: 'schedule', initiatorType: 'trigger' });
  });

  test('the creator sees their private, project and restricted sessions, never a soft-deleted one', async () => {
    expect(await visibleTo(CREATOR)).toEqual(['private', 'project', 'restricted']);
  });

  test('a project member sees project-visible sessions only', async () => {
    expect(await visibleTo(PLAIN)).toEqual(['project']);
  });

  test('a restricted share admits the named member and the named group`s member', async () => {
    expect(await visibleTo(MEMBER)).toEqual(['project', 'restricted']);
    expect(await visibleTo(GROUPED)).toEqual(['project', 'restricted']);
  });

  test('the account owner sees project sessions and trigger runs, not a member`s private session', async () => {
    expect(await visibleTo(OWNER)).toEqual(['project', 'trigger']);
  });

  test('a project manager gets the trigger-run override; a member does not', async () => {
    expect(await visibleTo(MANAGER)).toEqual(['project', 'trigger']);
  });

  test('an account member outside the project, and a stranger, see nothing', async () => {
    expect(await visibleTo(ACCOUNT_ONLY)).toEqual([]);
    expect(await visibleTo(STRANGER)).toEqual([]);
  });

  test('a member who lost the project role, or left the account, sees nothing (KRTX-1722)', async () => {
    expect(await visibleTo(LOST)).toEqual(['project']);
    expect(await visibleTo(REMOVED)).toEqual(['project']);
    await deleteFromView(
      db,
      projectMembers,
      and(eq(projectMembers.projectId, project.project_id), eq(projectMembers.userId, LOST)),
    );
    await deleteFromView(db, projectMembers, and(eq(projectMembers.projectId, project.project_id), eq(projectMembers.userId, REMOVED)));
    await deleteFromView(db, accountMembers, and(eq(accountMembers.accountId, project.account_id), eq(accountMembers.userId, REMOVED)));
    clearAuthorizeCaches();
    expect(await visibleTo(LOST)).toEqual([]);
    expect(await visibleTo(REMOVED)).toEqual([]);
  });

  test('account session oversight lets the owner see a member`s private session', async () => {
    await db.update(accounts).set({ adminsSeeAllSessions: true }).where(eq(accounts.accountId, project.account_id));
    invalidateSessionOversight();
    try {
      expect(await visibleTo(OWNER)).toEqual(['private', 'project', 'restricted', 'trigger']);
      // Oversight is the owner/admin's power, not a member's.
      expect(await visibleTo(PLAIN)).toEqual(['project']);
    } finally {
      await db.update(accounts).set({ adminsSeeAllSessions: false }).where(eq(accounts.accountId, project.account_id));
      invalidateSessionOversight();
    }
    expect(await visibleTo(OWNER)).toEqual(['project', 'trigger']);
  });

  test('a session that no longer exists is never visible', async () => {
    const ghost = { ...rows.get(ids.project)!, sessionId: crypto.randomUUID(), metadata: { deletedAt: 'x' } };
    expect((await maySeeSessions(CREATOR, [ghost])).size).toBe(0);
    expect((await maySeeSessions('', [rows.get(ids.project)!])).size).toBe(0);
  });
});

describe('filterSessionRecipients', () => {
  test('keeps, in order, only the users who may open the session', async () => {
    expect(await filterSessionRecipients(rows.get(ids.private)!, [STRANGER, CREATOR, PLAIN, OWNER, CREATOR])).toEqual([CREATOR]);
    expect(await filterSessionRecipients(rows.get(ids.restricted)!, [PLAIN, MEMBER, GROUPED, CREATOR])).toEqual([
      MEMBER,
      GROUPED,
      CREATOR,
    ]);
  });
});

// KRTX-1742 review: a share to a 500-member group started 500 checks of ~7
// queries each at once on a 5-connection pool.
describe('the recipient checks run at most 4 at a time', () => {
  test('a large candidate list keeps its order and never has more than 4 checks in flight', async () => {
    const real = authorize.listAccessible;
    let inFlight = 0;
    let peak = 0;
    const spy = spyOn(authorize, 'listAccessible').mockImplementation(async (...args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await Bun.sleep(5);
        return await real(...args);
      } finally {
        inFlight -= 1;
      }
    });
    try {
      const candidates = [PLAIN, MEMBER, GROUPED, CREATOR, MANAGER, OWNER, ACCOUNT_ONLY, STRANGER];
      expect(await filterSessionRecipients(rows.get(ids.project)!, candidates)).toEqual([
        PLAIN,
        MEMBER,
        GROUPED,
        CREATOR,
        MANAGER,
        OWNER,
      ]);
      // One check lists the projects twice (read, manage) in parallel.
      expect(peak).toBeLessThanOrEqual(4 * 2);

      peak = 0;
      expect(await filterTriggerRecipients(project.account_id, project.project_id, candidates)).toEqual([
        PLAIN,
        MEMBER,
        GROUPED,
        CREATOR,
        MANAGER,
        OWNER,
      ]);
      expect(peak).toBeLessThanOrEqual(4);
    } finally {
      spy.mockRestore();
    }
  });
});

// KRTX-1742 review: a backend's service account created a session and got an
// inbox row, which no one can read, on every turn end.
describe('only a person (an account member) is ever a recipient', () => {
  test('a service account the IAM lets open the session and read the triggers is not a recipient', async () => {
    // The IAM alone lets it in: its own private session, a project role.
    expect([...(await maySeeSessions(SERVICE_ACCOUNT, [rows.get(ids.trigger)!]))]).toEqual([ids.trigger]);
    expect([...(await mayReadProjectTriggers(SERVICE_ACCOUNT, project.account_id, [project.project_id]))]).toEqual([
      project.project_id,
    ]);

    expect(await filterSessionRecipients(rows.get(ids.trigger)!, [SERVICE_ACCOUNT, MANAGER])).toEqual([MANAGER]);
    expect(await filterTriggerRecipients(project.account_id, project.project_id, [SERVICE_ACCOUNT, PLAIN])).toEqual([PLAIN]);
  });

  test('personsAmong keeps the account`s members, in order, once each', async () => {
    expect(await personsAmong(project.account_id, [SERVICE_ACCOUNT, PLAIN, STRANGER, 'not-a-uuid', '', OWNER, PLAIN])).toEqual([
      PLAIN,
      OWNER,
    ]);
    expect(await personsAmong(project.account_id, [])).toEqual([]);
  });
});

describe('mayReadProjectTriggers / filterTriggerRecipients', () => {
  test('project members, managers and the account owner read the triggers; outsiders do not', async () => {
    const other = crypto.randomUUID();
    expect([...(await mayReadProjectTriggers(PLAIN, project.account_id, [project.project_id, other]))]).toEqual([
      project.project_id,
    ]);
    expect(await filterTriggerRecipients(project.account_id, project.project_id, [OWNER, MANAGER, PLAIN, ACCOUNT_ONLY, STRANGER])).toEqual([
      OWNER,
      MANAGER,
      PLAIN,
    ]);
  });
});
