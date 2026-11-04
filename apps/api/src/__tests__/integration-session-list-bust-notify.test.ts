/**
 * Integration test (real local PostgreSQL): a session write's list-memo bust
 * reaches every replica. The poll memo is replica-local, and dev runs two API
 * replicas behind round robin: the read before a pin and the revalidation after
 * it landed on one replica, the write on the other, so the revalidation was
 * still a 304 from before the pin (6 of 6 on dev after #10948). Replica A calls
 * `forgetSessionListPollEtags`; replica B (a second LISTEN client standing in
 * for it) must hear it, and a bust announced by B must drop this replica's
 * memoized pages.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { config } from '../config';
import { SESSION_LIST_BUST_CHANNEL, startConfigBaseMoveBroadcast, stopConfigBaseMoveBroadcast } from '../shared/pg-broadcast';
import {
  forgetSessionListPollEtags,
  peekSessionListPollEtag,
  storeSessionListPollEtag,
} from '../projects/lib/session-list-poll-memo';

let otherReplica: postgres.Sql;
const heard: string[] = [];
const key = (projectId: string) => ['user-1', '', 'jwt', '', '', projectId, 'group=none'].join('|');

beforeAll(async () => {
  otherReplica = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  await otherReplica.listen(SESSION_LIST_BUST_CHANNEL, (payload) => heard.push(payload));
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
});

afterAll(async () => {
  await stopConfigBaseMoveBroadcast();
  await otherReplica.end({ timeout: 2 }).catch(() => {});
});

const settle = () => Bun.sleep(300);

test('a write on this replica announces the bust to the other replica', async () => {
  const projectId = crypto.randomUUID();
  forgetSessionListPollEtags(projectId);
  await settle();
  expect(heard).toContain(projectId);
});

test('a bust announced by the other replica drops this replica’s memoized pages for that project only', async () => {
  const projectId = crypto.randomUUID();
  const otherProject = crypto.randomUUID();
  storeSessionListPollEtag(key(projectId), { etag: 'W/"a"', nextCursor: null, accountId: 'acc' });
  storeSessionListPollEtag(key(otherProject), { etag: 'W/"b"', nextCursor: null, accountId: 'acc' });

  await otherReplica.notify(SESSION_LIST_BUST_CHANNEL, projectId);
  await settle();

  expect(peekSessionListPollEtag(key(projectId), 'W/"a"')).toBeNull();
  expect(peekSessionListPollEtag(key(otherProject), 'W/"b"')?.etag).toBe('W/"b"');
});

test('a payload that is not a project id is ignored', async () => {
  const projectId = crypto.randomUUID();
  storeSessionListPollEtag(key(projectId), { etag: 'W/"c"', nextCursor: null, accountId: 'acc' });
  await otherReplica.notify(SESSION_LIST_BUST_CHANNEL, 'not-a-uuid');
  await settle();
  expect(peekSessionListPollEtag(key(projectId), 'W/"c"')?.etag).toBe('W/"c"');
});
