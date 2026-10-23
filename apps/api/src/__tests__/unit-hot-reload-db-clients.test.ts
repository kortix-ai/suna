/**
 * `bun --hot` re-evaluates a module and keeps globalThis. A second evaluation of
 * pg-broadcast / leader-election must end the first one's dedicated postgres.js
 * client instead of opening a second one beside it (a local stack held 95 LISTEN
 * and 57 lease connections after 3 h of edits). A `?query` import is a fresh
 * evaluation of the same file, which is what a hot reload does.
 */
import { expect, mock, test } from 'bun:test';

type FakeClient = { ended: boolean };
const clients: FakeClient[] = [];
function fakePostgres() {
  const client: FakeClient = { ended: false };
  clients.push(client);
  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const rows = strings.join('').includes('INSERT') ? [{ owner_id: values[1] }] : [];
    return Object.assign(Promise.resolve(rows), { cancel() {} });
  };
  return Object.assign(query, {
    unsafe: async () => [],
    listen: async () => {},
    notify: async () => {},
    end: async () => void (client.ended = true),
  });
}
mock.module('postgres', () => ({ default: fakePostgres }));

const { config } = await import('../config');
config.DATABASE_URL = 'postgres://fake';
const live = () => clients.filter((c) => !c.ended).length;
/** A fresh evaluation of a module, like the one `bun --hot` makes on save. */
const evaluate = <T>(path: string, n: number) => import(`${path}?eval=${n}`) as Promise<T>;
type Broadcast = typeof import('../shared/pg-broadcast');
type Election = typeof import('../shared/leader-election');
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

test('a re-evaluated pg-broadcast ends the previous LISTEN client', async () => {
  clients.length = 0;
  const first = await evaluate<Broadcast>('../shared/pg-broadcast.ts', 1);
  const second = await evaluate<Broadcast>('../shared/pg-broadcast.ts', 2);
  expect(await first.startConfigBaseMoveBroadcast()).toBe(true);
  expect(await second.startConfigBaseMoveBroadcast()).toBe(true);
  expect(clients.map((c) => c.ended)).toEqual([true, false]);
  // A second start in the same evaluation reuses its client.
  expect(await second.startConfigBaseMoveBroadcast()).toBe(true);
  expect(live()).toBe(1);
  await second.stopConfigBaseMoveBroadcast();
  expect(live()).toBe(0);
});

test('a re-evaluated leader election stops the previous loop and takes over the lease', async () => {
  clients.length = 0;
  const first = await evaluate<Election>('../shared/leader-election.ts', 1);
  const second = await evaluate<Election>('../shared/leader-election.ts', 2);
  const events: string[] = [];
  first.startLeaderElection({ onAcquire: () => void events.push('acquire 1'), onRelease: () => void events.push('release 1') });
  await flush();
  expect(first.isLeader()).toBe(true);

  second.startLeaderElection({ onAcquire: () => void events.push('acquire 2'), onRelease: () => void events.push('release 2') });
  await flush();
  // The first election released its workers and ended its client before the second one started.
  expect(events).toEqual(['acquire 1', 'release 1', 'acquire 2']);
  expect(first.isLeader()).toBe(false);
  expect(second.isLeader()).toBe(true);
  expect(clients.map((c) => c.ended)).toEqual([true, false]);

  await second.stopLeaderElection();
  expect(live()).toBe(0);
});
