/**
 * Integration test (real local PostgreSQL): a private-channel access bust
 * reaches every replica. Replica A calls
 * `bustSpaceAccess`; replica B (a second LISTEN client standing in for it)
 * must hear it, and a bust announced by B must run this process's bust
 * listeners (the proxy verdict cache and the open preview sockets). Before,
 * the bust cleared the writing replica only and the others kept the 10 s memo.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { config } from '../config';
import { SPACE_ACCESS_BUST_CHANNEL, startConfigBaseMoveBroadcast, stopConfigBaseMoveBroadcast } from '../shared/pg-broadcast';
import { bustSpaceAccess, onSpaceAccessBust } from '../shared/space-access';

let otherReplica: postgres.Sql;
const heard: string[] = [];
let localBusts = 0;

beforeAll(async () => {
  onSpaceAccessBust(() => {
    localBusts += 1;
  });
  otherReplica = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  await otherReplica.listen(SPACE_ACCESS_BUST_CHANNEL, (payload) => heard.push(payload));
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
});

afterAll(async () => {
  await stopConfigBaseMoveBroadcast();
  await otherReplica.end({ timeout: 2 }).catch(() => {});
});

const settle = () => Bun.sleep(300);

test('a bust on this replica is announced to the other replica', async () => {
  const projectId = crypto.randomUUID();
  bustSpaceAccess(projectId);
  await settle();
  expect(heard).toContain(projectId);
});

test('a bust announced by the other replica runs this replica’s bust listeners', async () => {
  const before = localBusts;
  await otherReplica.notify(SPACE_ACCESS_BUST_CHANNEL, crypto.randomUUID());
  await settle();
  expect(localBusts).toBeGreaterThan(before);
});

test('a payload that is not a project id is ignored', async () => {
  const before = localBusts;
  await otherReplica.notify(SPACE_ACCESS_BUST_CHANNEL, 'not-a-uuid');
  await settle();
  expect(localBusts).toBe(before);
});
