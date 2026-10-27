/**
 * Integration test (real PostgreSQL): session groups (`session_groups` flag),
 * the named folders of a project's sessions that every member shares.
 *
 * A group is created last in the project's order, renamed, reordered and
 * deleted; a session is filed into at most one group of its own project.
 * Filing never moves the session in the list (`updated_at` stays), and a
 * deleted group leaves its sessions in no group.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { SESSION_GROUPS_MAX } from '@kortix/api-contract';
import { db } from '../shared/db';
import {
  createSessionGroup,
  deleteSessionGroup,
  listSessionGroups,
  renameSessionGroup,
  reorderSessionGroups,
  setSessionGroup,
} from '../projects/lib/session-groups';
import {
  localTestDatabaseUrl,
  removeSeeded,
  seedProject,
  seedSession,
  type SeededProject,
} from './helpers/integration-fixtures';

let project: SeededProject;
let other: SeededProject;
const creator = crypto.randomUUID();

beforeAll(async () => {
  localTestDatabaseUrl();
  project = await seedProject('session-groups');
  other = await seedProject('session-groups-other');
});

afterAll(async () => {
  await removeSeeded([project, other]);
});

async function create(target: SeededProject, name: string) {
  const result = await createSessionGroup({
    accountId: target.account_id,
    projectId: target.project_id,
    name,
    createdBy: creator,
  });
  if (!result.ok) throw new Error(`create ${name}: ${result.code}`);
  return result.group;
}

async function names(target: SeededProject) {
  return (await listSessionGroups(target.project_id)).map((group) => `${group.position}:${group.name}`);
}

describe('session groups', () => {
  test('a new group goes last; the list is in position order', async () => {
    await create(project, 'Store A');
    await create(project, 'Store B');
    await create(project, 'Store C');
    expect(await names(project)).toEqual(['0:Store A', '1:Store B', '2:Store C']);
    const [first] = await listSessionGroups(project.project_id);
    expect(first!.createdBy).toBe(creator);
    expect(first!.accountId).toBe(project.account_id);
  });

  test('a name another group of the project has, in any case, is refused; another project may use it', async () => {
    const taken = await createSessionGroup({
      accountId: project.account_id,
      projectId: project.project_id,
      name: 'store a',
      createdBy: creator,
    });
    expect(taken).toEqual({ ok: false, code: 'group_name_taken' });
    await create(other, 'Store A');
    expect(await names(other)).toEqual(['0:Store A']);
  });

  test('rename: a free name, or the same name in another case; a taken name and an unknown or foreign group are refused', async () => {
    const [a, b] = await listSessionGroups(project.project_id);
    const renamed = await renameSessionGroup(project.project_id, a!.groupId, 'Store A (EU)');
    expect(renamed.ok && renamed.group.name).toBe('Store A (EU)');
    expect(renamed.ok && renamed.group.updatedAt.getTime()).toBeGreaterThanOrEqual(a!.updatedAt.getTime());
    const recased = await renameSessionGroup(project.project_id, b!.groupId, 'STORE B');
    expect(recased.ok && recased.group.name).toBe('STORE B');
    expect(await renameSessionGroup(project.project_id, b!.groupId, 'store a (eu)')).toEqual({
      ok: false,
      code: 'group_name_taken',
    });
    expect(await renameSessionGroup(project.project_id, crypto.randomUUID(), 'X')).toEqual({
      ok: false,
      code: 'group_not_found',
    });
    const [foreign] = await listSessionGroups(other.project_id);
    expect(await renameSessionGroup(project.project_id, foreign!.groupId, 'Mine now')).toEqual({
      ok: false,
      code: 'group_not_found',
    });
    expect(await names(other)).toEqual(['0:Store A']);
  });

  test('reorder takes every group id once; anything else is stale and changes nothing', async () => {
    const [a, b, c] = await listSessionGroups(project.project_id);
    const done = await reorderSessionGroups(project.project_id, [c!.groupId, a!.groupId, b!.groupId]);
    expect(done.ok && done.groups.map((group) => group.groupId)).toEqual([c!.groupId, a!.groupId, b!.groupId]);
    expect(await names(project)).toEqual(['0:Store C', '1:Store A (EU)', '2:STORE B']);

    const before = await names(project);
    const [foreign] = await listSessionGroups(other.project_id);
    for (const ids of [
      [c!.groupId, a!.groupId],
      [c!.groupId, a!.groupId, b!.groupId, foreign!.groupId],
      [c!.groupId, a!.groupId, foreign!.groupId],
    ]) {
      expect(await reorderSessionGroups(project.project_id, ids)).toEqual({ ok: false, code: 'group_order_stale' });
    }
    expect(await names(project)).toEqual(before);
  });

  test('filing a session: into a group of its project, out with null; never into a foreign group; updated_at stays', async () => {
    const sessionId = await seedSession(project, creator);
    const [group] = await listSessionGroups(project.project_id);
    const [foreign] = await listSessionGroups(other.project_id);
    const read = async () =>
      (await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId)))[0]!;
    const before = await read();

    expect(await setSessionGroup(project.project_id, sessionId, group!.groupId)).toEqual({
      ok: true,
      groupId: group!.groupId,
    });
    expect((await read()).groupId).toBe(group!.groupId);
    expect((await read()).updatedAt.getTime()).toBe(before.updatedAt.getTime());

    expect(await setSessionGroup(project.project_id, sessionId, foreign!.groupId)).toEqual({
      ok: false,
      code: 'group_not_found',
    });
    expect((await read()).groupId).toBe(group!.groupId);

    // A session of another project is not this project's to file.
    const otherSession = await seedSession(other, creator);
    expect(await setSessionGroup(project.project_id, otherSession, group!.groupId)).toEqual({
      ok: false,
      code: 'session_not_found',
    });

    expect(await setSessionGroup(project.project_id, sessionId, null)).toEqual({ ok: true, groupId: null });
    expect((await read()).groupId).toBeNull();
  });

  test('delete: its sessions go to no group, the rest close up, an unknown or foreign group is not found', async () => {
    const [first, second, third] = await listSessionGroups(project.project_id);
    const sessionId = await seedSession(project, creator);
    await setSessionGroup(project.project_id, sessionId, second!.groupId);

    expect(await deleteSessionGroup(project.project_id, second!.groupId)).toBe(true);
    const row = (await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId)))[0]!;
    expect(row.groupId).toBeNull();
    expect((await listSessionGroups(project.project_id)).map((group) => [group.groupId, group.position])).toEqual([
      [first!.groupId, 0],
      [third!.groupId, 1],
    ]);

    expect(await deleteSessionGroup(project.project_id, second!.groupId)).toBe(false);
    const [foreign] = await listSessionGroups(other.project_id);
    expect(await deleteSessionGroup(project.project_id, foreign!.groupId)).toBe(false);
    expect(await names(other)).toEqual(['0:Store A']);
  });

  test(`a project holds at most ${SESSION_GROUPS_MAX} groups`, async () => {
    const existing = (await listSessionGroups(project.project_id)).length;
    for (let i = existing; i < SESSION_GROUPS_MAX; i += 1) await create(project, `Group ${i}`);
    expect(await createSessionGroup({
      accountId: project.account_id,
      projectId: project.project_id,
      name: 'One too many',
      createdBy: creator,
    })).toEqual({ ok: false, code: 'group_limit' });
    expect((await listSessionGroups(project.project_id)).length).toBe(SESSION_GROUPS_MAX);
  });
});
