/**
 * The shared base-tip check against a real PostgreSQL: concurrent requests of
 * one `(project, ref)` ask the upstream once per interval, every other request
 * reads the stored tip, a base move expires the row, and a failed check does
 * not stand. The upstream is a recorded fake.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { accounts, baseTipChecks, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { dbBaseTipStore, expireBaseTips, sharedBaseTip } from './base-tip';

const TIP_A = 'a'.repeat(40);
const TIP_B = 'b'.repeat(40);
const INTERVAL_MS = 60_000;

let accountId: string;
let projectId: string;
let upstream: string;
let asks: number;
let clock: Date;

const project = () => ({ projectId, repoUrl: 'https://example.test/r.git', defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: null });
const deps = {
  store: dbBaseTipStore,
  ask: async () => {
    asks += 1;
    // Long enough that the concurrent requests below all arrive while it runs.
    await Bun.sleep(50);
    if (upstream === 'down') throw new Error('upstream unreachable');
    return upstream;
  },
  now: () => clock,
  intervalMs: () => INTERVAL_MS,
};
const tip = (ref = 'main') => sharedBaseTip(project(), ref, deps);

beforeEach(async () => {
  accountId = randomUUID();
  projectId = randomUUID();
  upstream = TIP_A;
  asks = 0;
  clock = new Date();
  await db.insert(accounts).values({ accountId, name: 'base tip test' });
  await db.insert(projects).values({ projectId, accountId, name: 'base tip test', repoUrl: 'https://example.test/r.git' });
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('sharedBaseTip', () => {
  test('one request asks the upstream; later requests in the interval read the stored tip', async () => {
    expect(await tip()).toBe(TIP_A);
    expect(asks).toBe(1);

    upstream = TIP_B;
    clock = new Date(clock.getTime() + INTERVAL_MS - 1);
    expect(await Promise.all([tip(), tip(), tip()])).toEqual([TIP_A, TIP_A, TIP_A]);
    expect(asks).toBe(1);

    // Past the interval exactly one of the concurrent requests asks again.
    clock = new Date(clock.getTime() + 2);
    await Promise.all([tip(), tip(), tip(), tip()]);
    expect(asks).toBe(2);
    expect(await tip()).toBe(TIP_B);
    expect(asks).toBe(2);
  });

  test('requests that arrive during the first check ask too: there is no tip to share yet', async () => {
    await Promise.all([tip(), tip()]);
    expect(asks).toBe(2);
    const [row] = await db.select().from(baseTipChecks).where(eq(baseTipChecks.projectId, projectId));
    expect(row!.tip).toBe(TIP_A);
  });

  test('each ref has its own row', async () => {
    await tip('main');
    await tip('release');
    expect(asks).toBe(2);
  });

  test('a base move expires every ref of the project: the next request asks', async () => {
    await tip('main');
    await tip('release');
    upstream = TIP_B;
    await expireBaseTips(projectId);
    expect(await tip('main')).toBe(TIP_B);
    expect(await tip('release')).toBe(TIP_B);
    expect(asks).toBe(4);
  });

  test('a move during a check keeps the row expired: the stale answer is not stored', async () => {
    const first = tip();
    // The expire must land inside the first check: after its claim committed and
    // before its record. A fixed sleep raced the claim's INSERT — under load the
    // INSERT could land after the expire, the expiry matched zero rows, and the
    // stale answer legitimately stored. ask() runs only after a won claim (and
    // sleeps 50 ms), so asks > 0 proves the claim committed while the check is
    // still in flight. Past that point both orderings pass: an expire during the
    // ask makes the record a no-op; an expire after the record leaves the row expired.
    for (let waited = 0; asks === 0 && waited < 5_000; waited += 10) await Bun.sleep(10);
    expect(asks).toBe(1);
    await expireBaseTips(projectId);
    expect(await first).toBe(TIP_A);
    upstream = TIP_B;
    expect(await tip()).toBe(TIP_B);
    expect(asks).toBe(2);
  });

  test('a failed check does not stand for the interval', async () => {
    await tip();
    clock = new Date(clock.getTime() + INTERVAL_MS + 1);
    upstream = 'down';
    await expect(tip()).rejects.toThrow('upstream unreachable');
    upstream = TIP_B;
    expect(await tip()).toBe(TIP_B);
    expect(asks).toBe(3);
  });
});
