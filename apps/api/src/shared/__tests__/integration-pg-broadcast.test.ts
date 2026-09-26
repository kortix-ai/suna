/**
 * Integration test (real local PostgreSQL): the base-move broadcast really
 * crosses a process boundary.
 *
 * The unit test for this (turn-start-convergence-cross-process.test.ts) proves
 * the wiring against a fake bus. It cannot prove the transport: `LISTEN`/
 * `NOTIFY` is a database feature, it does not work behind a transaction pooler,
 * and getting it wrong would look exactly like the bug it fixes — a pod that
 * silently keeps a stale desired release until the TTL runs out.
 *
 * Two independent `postgres` clients stand in for two api pods, because that is
 * what two pods are.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { config } from '../../config';
import {
  BASE_MOVE_CHANNEL,
  configBaseMoveTransport,
  startConfigBaseMoveBroadcast,
  stopConfigBaseMoveBroadcast,
} from '../pg-broadcast';
import {
  createDesiredReleaseCache,
  createDesiredReleaseInvalidation,
} from '../../projects/lib/turn-start-convergence';

const PROJECT = crypto.randomUUID();
let publisher: postgres.Sql;

beforeAll(async () => {
  publisher = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  const listening = await startConfigBaseMoveBroadcast();
  expect(listening).toBe(true);
});

afterAll(async () => {
  await stopConfigBaseMoveBroadcast();
  await publisher.end({ timeout: 2 }).catch(() => {});
});

function nextNotification(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no NOTIFY arrived within 10s')), 10_000);
    configBaseMoveTransport().subscribe((projectId) => {
      clearTimeout(timer);
      resolve(projectId);
    });
  });
}

describe('the base-move broadcast over real PostgreSQL', () => {
  test('a NOTIFY from another connection reaches this process', async () => {
    const arrived = nextNotification();
    await publisher.notify(BASE_MOVE_CHANNEL, PROJECT);
    expect(await arrived).toBe(PROJECT);
  }, 20_000);

  test('a NOTIFY drops the desired release this process had cached', async () => {
    let tip = 'a'.repeat(64);
    const cache = createDesiredReleaseCache(async () => tip, { enableInTests: true });
    // The production wiring, with the real transport.
    createDesiredReleaseInvalidation(cache, configBaseMoveTransport());
    const target = {
      projectId: PROJECT,
      accountId: 'acct',
      repoUrl: '/tmp/r.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      projectMetadata: {},
      baseRef: 'main',
      agentName: 'kortix',
      sessionMetadata: {},
      createdBy: 'user-1',
    } as never;

    expect(await cache.get(target, 'sess')).toBe('a'.repeat(64));
    tip = 'b'.repeat(64);
    // Still cached: nothing told this process the branch moved.
    expect(await cache.get(target, 'sess')).toBe('a'.repeat(64));

    const arrived = nextNotification();
    await publisher.notify(BASE_MOVE_CHANNEL, PROJECT);
    await arrived;

    expect(await cache.get(target, 'sess')).toBe('b'.repeat(64));
  }, 20_000);

  test('a payload that is not a project id is ignored', async () => {
    const seen: string[] = [];
    configBaseMoveTransport().subscribe((projectId) => seen.push(projectId));
    await publisher.notify(BASE_MOVE_CHANNEL, 'not-a-uuid');
    const arrived = nextNotification();
    await publisher.notify(BASE_MOVE_CHANNEL, PROJECT);
    await arrived;
    expect(seen).toEqual([PROJECT]);
  }, 20_000);
});
