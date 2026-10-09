/**
 * Integration test (real local DB): a session push reaches only people who may
 * still open the session's project (KRTX-1722). Before, the notifier checked
 * account membership only, so a member removed from the project but kept in
 * the account still got the session titles and the agent's questions.
 * Real: the account and project roles and the IAM project-list rule.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, projectMembers } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { clearAuthorizeCaches } from '../iam/authorize';
import { mayReceiveSessionPush } from '../notifications/session-push';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const ACCOUNT_ONLY = crypto.randomUUID();
const STRANGER = crypto.randomUUID();
const users = [OWNER, MEMBER, ACCOUNT_ONLY, STRANGER];

let project: SeededProject;
const target = () => ({
  createdBy: MEMBER,
  title: 'A session title',
  accountId: project.account_id,
  projectId: project.project_id,
});

beforeAll(async () => {
  project = await seedProject('push-recipients');
  const user = (id: string) =>
    sql`(${id}::uuid, ${`push-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`
    INSERT INTO auth.users (id, email, instance_id, aud, role)
    VALUES ${user(OWNER)}, ${user(MEMBER)}, ${user(ACCOUNT_ONLY)}, ${user(STRANGER)}`);
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member' },
    { userId: ACCOUNT_ONLY, accountId: project.account_id, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
}, 20_000);

afterAll(async () => {
  if (!project) return;
  await removeSeeded([project]);
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join(users.map((id) => sql`${id}::uuid`), sql`, `)})`);
});

describe('who may receive a session push', () => {
  test('the account owner and a member of the project: yes', async () => {
    expect(await mayReceiveSessionPush(OWNER, target())).toBe(true);
    expect(await mayReceiveSessionPush(MEMBER, target())).toBe(true);
  });

  test('an account member who is not in the project, and a stranger: no', async () => {
    expect(await mayReceiveSessionPush(ACCOUNT_ONLY, target())).toBe(false);
    expect(await mayReceiveSessionPush(STRANGER, target())).toBe(false);
  });

  test('the creator removed from the project but kept in the account: no', async () => {
    await deleteFromView(
      db,
      projectMembers,
      and(eq(projectMembers.projectId, project.project_id), eq(projectMembers.userId, MEMBER)),
    );
    clearAuthorizeCaches();
    expect(await mayReceiveSessionPush(MEMBER, target())).toBe(false);
  });

  test('a session with no project or account on record: no', async () => {
    expect(await mayReceiveSessionPush(OWNER, { ...target(), projectId: null })).toBe(false);
    expect(await mayReceiveSessionPush(OWNER, { ...target(), accountId: null })).toBe(false);
  });
});
