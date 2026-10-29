/**
 * Private-channel access across replicas and on open streams.
 *
 * - `bustSpaceAccess` publishes the bust (`kortix_space_access_bust`), and a
 *   bust heard from another replica runs this replica's listeners.
 * - `sessionStreamAccessCheck`: no full check in a project without a private
 *   channel; a failed read closes a private channel's session only.
 *
 * The DB and the bus are fakes; the real LISTEN/NOTIFY round trip is
 * `__tests__/integration-space-access-bust-notify.test.ts`.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import { projectSessions, projectSpaces } from '@kortix/db';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-0000000000b1';
const PRIVATE = '00000000-0000-4000-8000-0000000000c1';

const published: string[] = [];
let heard: ((projectId: string) => void) | null = null;
mock.module('./pg-broadcast', () => ({
  publishSpaceAccessBust: (projectId: string) => published.push(projectId),
  onSpaceAccessBustNotify: (handler: (projectId: string) => void) => {
    heard = handler;
  },
}));

/** What the fake DB answers, and every table it was asked about. */
const state = { privateIds: [] as string[], sessionSpace: null as string | null, failing: false, failSessionRead: false, reads: [] as string[] };
const answer = (table: unknown) => {
  const name = table === projectSpaces ? 'project_spaces' : table === projectSessions ? 'project_sessions' : 'other';
  state.reads.push(name);
  if (state.failing || (name === 'project_sessions' && state.failSessionRead)) return Promise.reject(new Error('connection terminated'));
  if (name === 'project_spaces') return Promise.resolve(state.privateIds.map((spaceId) => ({ spaceId })));
  return Promise.resolve([{ spaceId: state.sessionSpace }]);
};
mock.module('./db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => answer(table).then(resolve, reject),
          limit: () => answer(table),
        }),
      }),
    }),
  },
}));

const { bustSpaceAccess, onSpaceAccessBust, sessionStreamAccessCheck } = await import('./space-access');

beforeEach(() => {
  Object.assign(state, { privateIds: [], sessionSpace: null, failing: false, failSessionRead: false, reads: [] });
  published.length = 0;
});

test('I2: a bust is published to every replica, and a bust heard from another replica runs the local listeners', () => {
  let local = 0;
  onSpaceAccessBust(() => {
    local += 1;
  });
  bustSpaceAccess(PROJECT);
  expect(published).toEqual([PROJECT]);
  expect(local).toBe(1);
  expect(heard).not.toBeNull();
  heard!(PROJECT);
  expect(local).toBe(2);
  // The echo of this replica's own NOTIFY is not published again.
  expect(published).toEqual([PROJECT]);
});

test('a project with no private channel: allowed without the full check, one project_spaces read (memoized 5 min outside tests)', async () => {
  let checks = 0;
  const recheck = sessionStreamAccessCheck(PROJECT, SESSION, async () => {
    checks += 1;
    return false;
  });
  expect(await recheck()).toBe(true);
  expect(await recheck()).toBe(true);
  expect(checks).toBe(0);
  expect(state.reads).toEqual(['project_spaces', 'project_spaces']);
});

test('a project with a private channel: the full check decides', async () => {
  state.privateIds = [PRIVATE];
  let allowed = true;
  const recheck = sessionStreamAccessCheck(PROJECT, SESSION, async () => allowed);
  expect(await recheck()).toBe(true);
  allowed = false;
  expect(await recheck()).toBe(false);
});

test('a DB error keeps an ordinary session’s stream open', async () => {
  // The project has a private channel; this session is not in it.
  state.privateIds = [PRIVATE];
  state.sessionSpace = null;
  let fail = false;
  const recheck = sessionStreamAccessCheck(PROJECT, SESSION, async () => {
    if (fail) throw new Error('connection terminated');
    return true;
  });
  expect(await recheck()).toBe(true);
  fail = true;
  expect(await recheck()).toBe(true);
  state.failing = true; // every read fails now, the project's list included
  expect(await recheck()).toBe(true);
});

test('a DB error keeps the stream of a project with no private channel open', async () => {
  const recheck = sessionStreamAccessCheck(PROJECT, SESSION, async () => true);
  expect(await recheck()).toBe(true);
  state.failing = true;
  expect(await recheck()).toBe(true);
});

test('a DB error closes a private channel’s session (fail closed)', async () => {
  state.privateIds = [PRIVATE];
  state.sessionSpace = PRIVATE;
  let fail = false;
  const recheck = sessionStreamAccessCheck(PROJECT, SESSION, async () => {
    if (fail) throw new Error('connection terminated');
    return true;
  });
  expect(await recheck()).toBe(true);
  fail = true;
  expect(await recheck()).toBe(false);
  // Every read fails: the last known answer (in a private channel) closes it.
  const again = sessionStreamAccessCheck(PROJECT, SESSION, async () => true);
  expect(await again()).toBe(true);
  state.failing = true;
  expect(await again()).toBe(false);
});

test('the first re-check fails in a project with a private channel and the session’s space is unknown: it closes', async () => {
  state.privateIds = [PRIVATE];
  state.failSessionRead = true;
  const recheck = sessionStreamAccessCheck(PROJECT, SESSION, async () => {
    throw new Error('timeout');
  });
  expect(await recheck()).toBe(false);
});
