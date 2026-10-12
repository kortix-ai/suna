// Following and muting a session on PostgreSQL (KRTX-1742): the creator
// follows without a row, a prompter's auto-watch never un-mutes, and a muted
// row silences the creator too. The routes that call these are
// `projects/routes/session-watch.ts` and `session-prompts.ts`.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { notificationWatchers } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { autoWatchSession, isWatchingSession, sessionWatchersOf, setSessionWatch } from './watchers';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

withDb('session watch', () => {
  const seeded: SeededProject[] = [];
  let project: SeededProject;
  let sessionId: string;
  let creator: string;
  let prompter: string;

  beforeEach(async () => {
    creator = crypto.randomUUID();
    prompter = crypto.randomUUID();
    project = await seedProject(`watch-${crypto.randomUUID().slice(0, 8)}`);
    seeded.push(project);
    sessionId = await seedSession(project, creator);
  });

  afterAll(async () => {
    await removeSeeded(seeded);
  });

  test('the creator follows with no row; anyone else follows only with an unmuted row', async () => {
    expect(await isWatchingSession(sessionId, creator, creator)).toBe(true);
    expect(await isWatchingSession(sessionId, prompter, creator)).toBe(false);
    await autoWatchSession(project.project_id, sessionId, prompter);
    expect(await isWatchingSession(sessionId, prompter, creator)).toBe(true);
  });

  test('muting silences the creator; unmuting restores them', async () => {
    await setSessionWatch(project.project_id, sessionId, creator, false);
    expect(await isWatchingSession(sessionId, creator, creator)).toBe(false);
    expect((await sessionWatchersOf(sessionId, creator)).watching).toEqual([]);
    await setSessionWatch(project.project_id, sessionId, creator, true);
    expect(await isWatchingSession(sessionId, creator, creator)).toBe(true);
  });

  test('a prompt after a mute does not un-mute', async () => {
    await setSessionWatch(project.project_id, sessionId, prompter, false);
    await autoWatchSession(project.project_id, sessionId, prompter);
    expect(await isWatchingSession(sessionId, prompter, creator)).toBe(false);
    const rows = await db.select().from(notificationWatchers).where(eq(notificationWatchers.sessionId, sessionId));
    expect(rows.map((row) => ({ userId: row.userId, muted: row.muted }))).toEqual([{ userId: prompter, muted: true }]);
  });

  test('a second prompt writes no second row', async () => {
    await autoWatchSession(project.project_id, sessionId, prompter);
    await autoWatchSession(project.project_id, sessionId, prompter);
    const rows = await db.select().from(notificationWatchers).where(eq(notificationWatchers.sessionId, sessionId));
    expect(rows).toHaveLength(1);
  });
});
