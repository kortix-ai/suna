/**
 * Integration test (real PostgreSQL): who a goal notice reaches.
 *
 * A goal tells the person it is for: its assignee, else its creator. That
 * person is told only while they may read the project (an account member with
 * `project.read`), the access the goal page itself requires. An assignee who
 * lost the project does not silence the goal: its creator is told instead.
 * When neither may read the project, no inbox row, push or email is written.
 * `deliver` writes one inbox row per recipient it is given, and push and email
 * go to the same list, so the rows show who was told.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, notifications, projectMembers } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../../__tests__/helpers/integration-fixtures';
import { notifyGoal } from './notify';

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
/** An account member with no role on the project. */
const OUTSIDER = crypto.randomUUID();
/** Not a member of the account (removed, or never in it). */
const GONE = crypto.randomUUID();

let project: SeededProject;
let sibling: SeededProject | undefined;
let ownerSessionId: string;

function goal(createdByUserId: string, assignedUserId: string | null) {
  return {
    goalId: crypto.randomUUID(),
    accountId: project.account_id,
    projectId: project.project_id,
    ownerSessionId,
    title: 'Ship the weekly report',
    createdByUserId,
    assignedUserId,
  };
}

async function toldAbout(goalId: string): Promise<string[]> {
  const rows = await db.select({ userId: notifications.userId, dedupeKey: notifications.dedupeKey }).from(notifications)
    .where(eq(notifications.projectId, project.project_id));
  return rows.filter((row) => row.dedupeKey?.startsWith(`goal:${goalId}:`)).map((row) => row.userId).sort();
}

beforeAll(async () => {
  project = await seedProject('goal-notify');
  // A legacy account (2 projects, split_pending): only there does an account
  // member without a project role stay out of the project. In a 1:1
  // workspace membership is access (design.md §3.2 C3).
  sibling = await seedProject('goal-notify-sibling', { accountId: project.account_id });
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member' },
    { userId: OUTSIDER, accountId: project.account_id, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
  ownerSessionId = await seedSession(project, OWNER);
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.projectId, project.project_id));
  await removeSeeded(sibling ? [sibling, project] : [project]);
});

describe('a goal notice reaches only a person who may read the project', () => {
  test('an assignee who is a project member is told; the creator is not', async () => {
    const g = goal(OWNER, MEMBER);
    await notifyGoal(g, 'needs_you', 'Which week should the report cover?', new Date());
    expect(await toldAbout(g.goalId)).toEqual([MEMBER]);
  });

  test('an assignee with no role on the project is never told; the creator who may read it is told instead', async () => {
    const g = goal(MEMBER, OUTSIDER);
    await notifyGoal(g, 'blocked', 'The data source refused the request.', new Date());
    expect(await toldAbout(g.goalId)).toEqual([MEMBER]);
  });

  test('a creator with no role on the project and no assignee: nobody is told', async () => {
    const g = goal(OUTSIDER, null);
    await notifyGoal(g, 'verification_failed', 'Criterion 2 has no evidence file.', new Date());
    expect(await toldAbout(g.goalId)).toEqual([]);
  });

  test('a creator removed from the account and an assignee with no project role: nobody is told', async () => {
    const g = goal(GONE, OUTSIDER);
    await notifyGoal(g, 'verified_done', '', new Date());
    expect(await toldAbout(g.goalId)).toEqual([]);
  });
});
