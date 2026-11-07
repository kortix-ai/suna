/**
 * Integration test (real local DB, fake Drive volume, notice delivery
 * recorded): a space's event feed and its watcher's wakes
 * (`projects/lib/space-watch/`, flag `spaces_proactive`).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accounts, projectSessions, projectSpaceEvents, projectSpaces, projectSpaceWatchers, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

/** One record per wake: the fresh session each wake creates (wake.ts `setWakeSessionCreatorForTests`). */
const notices: Array<{ sessionId: string; text: string; key: string; actorUserId: string | null; spaceId: unknown }> = [];

const { config } = await import('../config');
const { db } = await import('../shared/db');
const { setVolumeOpsForTests } = await import('../memory/volume-ops');
const { FakeVolume } = await import('./helpers/memory-fake-volume');
const { ensureProjectDrive } = await import('../drives/service');
const { insertSpaceMembers } = await import('../projects/lib/project-space-members');
const store = await import('../projects/lib/space-watch/store');
const { runSpaceWatcherTick, setWakeSessionCreatorForTests } = await import('../projects/lib/space-watch/wake');
setWakeSessionCreatorForTests((async (input: { userId: string; body: { initial_prompt?: string; space_id?: unknown }; idempotencyKey?: string }) => {
  const sessionId = crypto.randomUUID();
  notices.push({ sessionId, text: String(input.body.initial_prompt ?? ''), key: String(input.idempotencyKey ?? ''), actorUserId: input.userId, spaceId: input.body.space_id });
  return { row: { sessionId }, sessionId };
}) as never);
const { SPACE_EVENTS_KEEP, WATCH_DAILY_WAKES } = await import('../projects/lib/space-watch/policy');

(config as { PLATINUM_API_KEY?: string }).PLATINUM_API_KEY ||= 'test-key';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OFF_PROJECT = crypto.randomUUID();
const ANA = crypto.randomUUID();
const BO = crypto.randomUUID();
const LAUNCH = crypto.randomUUID();
const QUIET = crypto.randomUUID();
const OFF_SPACE = crypto.randomUUID();
const WATCHER = crypto.randomUUID();
const volume = new FakeVolume();
const T0 = new Date('2026-11-05T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const eventsOf = (spaceId: string) => db.select().from(projectSpaceEvents).where(eq(projectSpaceEvents.spaceId, spaceId));
const watchOf = async (spaceId: string) => (await db.select().from(projectSpaceWatchers).where(eq(projectSpaceWatchers.spaceId, spaceId)))[0]!;

beforeAll(async () => {
  setVolumeOpsForTests(volume);
  for (const [id, name] of [[ANA, 'ana'], [BO, 'bo']] as const) {
    await db.execute(sql`INSERT INTO auth.users (id, email, instance_id, aud, role, raw_user_meta_data) VALUES (${id}::uuid, ${`space-watch-${name}-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${JSON.stringify({ full_name: name === 'ana' ? 'Ana Lima' : 'Bo Chen' })}::jsonb)`);
  }
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'space-watch' });
  // Two projects in one account: a legacy (split_pending) account, as
  // uq_projects_workspace_account requires.
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'space-watch', repoUrl: 'https://example.test/w.git', metadata: { experimental: { chat: true, spaces_proactive: true } }, splitPending: true },
    { projectId: OFF_PROJECT, accountId: ACCOUNT, name: 'space-watch-off', repoUrl: 'https://example.test/o.git', metadata: { experimental: { chat: true } }, splitPending: true },
  ]);
  await db.insert(projectSpaces).values([
    { spaceId: LAUNCH, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'launch', name: 'launch', createdBy: ANA },
    { spaceId: QUIET, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: 'quiet', name: 'quiet', createdBy: ANA },
    { spaceId: OFF_SPACE, accountId: ACCOUNT, projectId: OFF_PROJECT, kind: 'channel', slug: 'launch', name: 'launch', createdBy: ANA },
  ]);
  await db.insert(projectSessions).values({ sessionId: WATCHER, accountId: ACCOUNT, projectId: PROJECT, branchName: 'w', createdBy: ANA, agentName: 'mykortix', visibility: 'private', metadata: { space_watcher: LAUNCH } });
  await ensureProjectDrive(ACCOUNT, PROJECT);
  volume.put('/Company/Channels/launch/context.md', '# #launch: context\nShip v2 on Friday.\n');
});

afterAll(async () => {
  setVolumeOpsForTests(null);
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, OFF_PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${ANA}::uuid, ${BO}::uuid)`);
});

describe('the event feed', () => {
  test('nothing is written while Proactive is off, or while the project lacks the flag', async () => {
    expect(await store.recordSpaceEvent({ spaceId: LAUNCH, kind: 'member_joined', line: '- a', dedupeKey: 'a' })).toBeNull();
    await store.writeWatcher({ projectId: OFF_PROJECT, spaceId: OFF_SPACE, ownerUserId: ANA, actorId: ANA, enabled: true });
    expect(await store.recordSpaceEvent({ spaceId: OFF_SPACE, kind: 'member_joined', line: '- a', dedupeKey: 'a' })).toBeNull();
    expect(await eventsOf(LAUNCH)).toEqual([]);
    expect(await eventsOf(OFF_SPACE)).toEqual([]);
  });

  test('with Proactive on: one row per event, a repeated key writes nothing', async () => {
    await store.writeWatcher({ projectId: PROJECT, spaceId: LAUNCH, ownerUserId: ANA, actorId: ANA, enabled: true });
    const first = await store.recordSpaceEvent({ spaceId: LAUNCH, kind: 'turn_finished', line: '- thread finished', dedupeKey: 'turn:1' });
    expect(first).toBeGreaterThan(0);
    expect(await store.recordSpaceEvent({ spaceId: LAUNCH, kind: 'turn_finished', line: '- thread finished', dedupeKey: 'turn:1' })).toBeNull();
    expect((await eventsOf(LAUNCH)).map((e) => e.line)).toEqual(['- thread finished']);
  });

  test('a person added to a watched channel becomes a "joined" line with their name', async () => {
    await insertSpaceMembers(LAUNCH, [BO], ANA);
    for (let i = 0; i < 100 && (await eventsOf(LAUNCH)).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const joined = (await eventsOf(LAUNCH)).find((e) => e.kind === 'member_joined');
    expect(joined?.line).toMatch(/· joined · Bo Chen$/);
  });

  test(`a space keeps its newest ${SPACE_EVENTS_KEEP} rows`, async () => {
    await store.writeWatcher({ projectId: PROJECT, spaceId: QUIET, ownerUserId: ANA, actorId: ANA, enabled: true });
    for (let i = 0; i < SPACE_EVENTS_KEEP + 3; i++) {
      await store.recordSpaceEvent({ spaceId: QUIET, kind: 'turn_finished', line: `- line ${i}`, dedupeKey: `bulk:${i}` });
    }
    const rows = await eventsOf(QUIET);
    expect(rows).toHaveLength(SPACE_EVENTS_KEEP);
    expect(rows.map((r) => r.line)).not.toContain('- line 2');
    expect(rows.map((r) => r.line)).toContain(`- line ${SPACE_EVENTS_KEEP + 2}`);
    // Out of the tick's way for the next tests.
    await store.writeWatcher({ projectId: PROJECT, spaceId: QUIET, ownerUserId: ANA, actorId: ANA, enabled: false });
  });

  test('events after a cursor, oldest first, with the count left over', async () => {
    const all = await eventsOf(LAUNCH);
    const page = await store.eventsAfter(LAUNCH, 0, 1);
    expect(page.rows.map((r) => r.line)).toEqual([all[0]!.line]);
    expect(page.more).toBe(all.length - 1);
  });
});

describe('the tick wakes the watcher', () => {
  test('new events wake it once: one fresh session, as its person, filed in no space, with events, brief and rules; events.md is written; the cursor moves', async () => {
    const result = await runSpaceWatcherTick(at(0));
    expect(result).toMatchObject({ watchers: 1, woken: 1 });
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice!.actorUserId).toBe(ANA);
    // Filed in no space: without `space_id: null` session create files it in #general.
    expect(notice!.spaceId).toBeNull();
    expect((await watchOf(LAUNCH)).watcherSessionId).toBe(notice!.sessionId);
    expect(notice!.text).toContain('## Space watch: #launch');
    expect(notice!.text).toContain('- thread finished');
    expect(notice!.text).toContain('Ship v2 on Friday.');
    expect(notice!.text).toContain('Answer with exactly one JSON object');
    expect(volume.files.get('/Company/Channels/launch/events.md')?.text).toContain('- thread finished');
    const watch = await watchOf(LAUNCH);
    expect(watch.cursor).toBe(Math.max(...(await eventsOf(LAUNCH)).map((e) => e.eventId)));
    expect(watch.wakesOnDay).toBe(1);
    expect(watch.wakeDay).toBe('2026-11-05');
  });

  test('nothing new: no wake. A new event 5 min later waits for the 10-min window, then wakes', async () => {
    expect((await runSpaceWatcherTick(at(2))).woken).toBe(0);
    await store.recordSpaceEvent({ spaceId: LAUNCH, kind: 'turn_finished', line: '- second result', dedupeKey: 'turn:2' });
    expect(await runSpaceWatcherTick(at(5))).toMatchObject({ woken: 0, skipped: { debounce: 1 } });
    expect(notices).toHaveLength(1);
    expect((await runSpaceWatcherTick(at(config.KORTIX_SPACE_WATCH_DEBOUNCE_MS / 60_000))).woken).toBe(1);
    expect(notices.at(-1)!.text).toContain('- second result');
    expect(notices.at(-1)!.text).not.toContain('- thread finished');
  });

  test('an urgent event wakes inside the window', async () => {
    await store.recordSpaceEvent({ spaceId: LAUNCH, kind: 'ask_overdue', line: '- waits for a person 3 h', dedupeKey: 'ask:1', urgent: true });
    expect((await runSpaceWatcherTick(at(11))).woken).toBe(1);
    expect(notices.at(-1)!.text).toContain('Someone has waited for a person too long');
  });

  test(`the day's budget (${WATCH_DAILY_WAKES}) holds every wake until the next UTC day`, async () => {
    await db.update(projectSpaceWatchers).set({ wakesOnDay: WATCH_DAILY_WAKES }).where(eq(projectSpaceWatchers.spaceId, LAUNCH));
    await store.recordSpaceEvent({ spaceId: LAUNCH, kind: 'ask_overdue', line: '- another ask', dedupeKey: 'ask:2', urgent: true });
    const before = notices.length;
    expect(await runSpaceWatcherTick(at(30))).toMatchObject({ woken: 0, skipped: { budget: 1 } });
    expect(notices).toHaveLength(before);
    const tomorrow = new Date('2026-11-06T00:05:00.000Z');
    expect((await runSpaceWatcherTick(tomorrow)).woken).toBe(1);
    expect((await watchOf(LAUNCH)).wakesOnDay).toBe(1);
  });

  test('a cursor never moves back, and one answer is claimed once', async () => {
    const watch = await watchOf(LAUNCH);
    await store.markWake({ spaceId: LAUNCH, cursor: 1, at: at(60), utcDay: '2026-11-06', wakesOnDay: 2, briefOn: null, watcherSessionId: WATCHER });
    expect((await watchOf(LAUNCH)).cursor).toBe(watch.cursor);
    expect(await store.claimDecision(LAUNCH, 'msg_1')).toBe(true);
    expect(await store.claimDecision(LAUNCH, 'msg_1')).toBe(false);
    expect(await store.claimDecision(LAUNCH, 'msg_2')).toBe(true);
  });

  test('rows older than 14 days are deleted', async () => {
    await db.update(projectSpaceEvents).set({ createdAt: new Date('2026-10-01T00:00:00.000Z') }).where(eq(projectSpaceEvents.spaceId, QUIET));
    expect(await store.pruneSpaceEvents(at(0))).toBeGreaterThanOrEqual(SPACE_EVENTS_KEEP);
    expect(await eventsOf(QUIET)).toEqual([]);
  });
});
