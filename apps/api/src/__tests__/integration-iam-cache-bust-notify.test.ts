/**
 * Integration test (real local PostgreSQL): an authz cache bust reaches every
 * replica. Replica A demotes a member and calls `invalidateIamCacheForUser`;
 * replica B (a second LISTEN client standing in for it) must hear the bust, and
 * a bust announced by B must clear the memos of this process. Without the
 * channel a demotion stayed visible on the other replica for the 15 s TTL.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { config } from '../config';
import {
  invalidateIamCacheForProjectResources,
  invalidateIamCacheForUser,
  registerPrincipalScopedMemo,
  registerProjectScopedMemo,
} from '../iam/cache-invalidation';
import {
  IAM_CACHE_BUST_CHANNEL,
  startConfigBaseMoveBroadcast,
  stopConfigBaseMoveBroadcast,
} from '../shared/pg-broadcast';

let otherReplica: postgres.Sql;
let heard: string[] = [];
const bustedPrefixes: string[] = [];
const bustedProjects: string[] = [];

beforeAll(async () => {
  registerPrincipalScopedMemo({ invalidateByPrefix: (p) => bustedPrefixes.push(p) });
  registerProjectScopedMemo({ invalidateByPrefix: (p) => bustedProjects.push(p) });
  otherReplica = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  await otherReplica.listen(IAM_CACHE_BUST_CHANNEL, (payload) => heard.push(payload));
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
});

afterAll(async () => {
  await stopConfigBaseMoveBroadcast();
  await otherReplica.end({ timeout: 2 }).catch(() => {});
});

const settle = () => Bun.sleep(300);

test('a user bust on this replica is announced to the other replica', async () => {
  const userId = crypto.randomUUID();
  heard = [];
  invalidateIamCacheForUser(userId);
  await settle();
  expect(heard).toContain(`user:${userId}`);
});

test('a project bust on this replica is announced to the other replica', async () => {
  const projectId = crypto.randomUUID();
  heard = [];
  invalidateIamCacheForProjectResources(projectId);
  await settle();
  expect(heard).toContain(`project:${projectId}`);
});

test('a bust announced by the other replica clears this replica\'s memos', async () => {
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await otherReplica.notify(IAM_CACHE_BUST_CHANNEL, `user:${userId}`);
  await otherReplica.notify(IAM_CACHE_BUST_CHANNEL, `project:${projectId}`);
  await settle();
  expect(bustedPrefixes).toContain(`${userId}|`);
  expect(bustedProjects).toContain(`${projectId}|`);
});
