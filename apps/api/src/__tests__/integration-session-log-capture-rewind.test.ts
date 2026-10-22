/**
 * Integration test (real PostgreSQL, fresh migrated database): the capture of a box without a
 * journal (`writeSessionLogFromRead`, `session-log-capture.ts`) on a rewound, re-pinned or large
 * box. Every session here is synthetic.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { accountMembers, projectSessions, sessionLogMessages } from '@kortix/db';
import { asc, eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { syntheticOpencodeSession } from './helpers/synthetic-opencode-session';

const { captureJournallessSessionLog } = await import('../projects/lib/session-transcript-capture');
const { readTranscriptPages } = await import('../projects/lib/session-transcript-pages');
const { MIRROR_CAPTURE_LIMIT } = await import('../projects/lib/session-transcript-mirror');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_rewindroot0000000000001';
const MOVED = 'ses_rewindroot0000000000002';
const PI = 'ses_pi0123456789abcdef01234567';
const CHILD = 'ses_rewindchild000000000001';
let project: SeededProject;

type Msg = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

/** `msg_<n>` created at n seconds, in runtime session `root`: user on even n, assistant on odd. */
const plain = (n: number, root = ROOT): Msg => {
  const id = `msg_${String(n).padStart(6, '0')}`;
  const created = 1_790_000_000_000 + n * 1000;
  const info: Record<string, unknown> =
    n % 2 === 0
      ? { id, sessionID: root, role: 'user', time: { created }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' } }
      : { id, sessionID: root, role: 'assistant', parentID: `msg_${String(n - 1).padStart(6, '0')}`, time: { created, completed: created + 500 }, providerID: 'kortix', modelID: 'm', finish: 'stop' };
  return { info, parts: [{ id: `prt_${n}`, sessionID: root, messageID: id, type: 'text', text: `reply ${n}` }] };
};
const msgs = (ns: number[], root = ROOT) => ns.map((n) => plain(n, root));
const span = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const idOf = (n: number) => `msg_${String(n).padStart(6, '0')}`;

/** A fake box of runtime session `root` answering `payload`; `complete` false is a partial read. */
const box = (root: string, payload: Msg[], complete = true, children: Array<{ id: string; payload: Msg[] }> = []) => ({
  readMessages: async () => ({
    opencodeSessionId: root,
    payload,
    headComplete: complete,
    complete,
    children: children.map((c) => ({ opencodeSessionId: c.id, payload: c.payload, complete: true })),
  }),
});

const logRows = (sessionId: string) =>
  db
    .select({ id: sessionLogMessages.messageId, thread: sessionLogMessages.threadId, seq: sessionLogMessages.seq, deletedAt: sessionLogMessages.deletedAt })
    .from(sessionLogMessages)
    .where(eq(sessionLogMessages.sessionId, sessionId))
    .orderBy(asc(sessionLogMessages.threadId), asc(sessionLogMessages.seq));
/** The live rows of `thread` as [message id, seq]. */
const live = async (sessionId: string, thread = ROOT) =>
  (await logRows(sessionId)).filter((r) => r.deletedAt === null && r.thread === thread).map((r) => [r.id, r.seq]);
const tombstoned = async (sessionId: string) => (await logRows(sessionId)).filter((r) => r.deletedAt !== null).map((r) => r.id).sort();
const inOrder = (ns: number[]) => ns.map((n, i) => [idOf(n), i + 1]);

const pinned = async (root = ROOT) => {
  const session = await seedSession(project, OWNER);
  await db.update(projectSessions).set({ runtimeSessionId: root }).where(eq(projectSessions.sessionId, session));
  return session;
};

beforeAll(async () => {
  project = await seedProject('session-log-capture-rewind');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
});

afterAll(async () => {
  await removeSeeded([project]);
});

describe('a box without a journal: rewind, re-pin, size', () => {
  test('an OpenCode rewind: a complete read that lacks stored root messages and lists a newer one tombstones them; the seqs after them close up', async () => {
    const session = await pinned();
    expect(await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 8))))).not.toBeNull();
    // Rewound to msg 3, then a new turn (10, 11).
    expect(await captureJournallessSessionLog(session, box(ROOT, msgs([0, 1, 2, 3, 10, 11])))).not.toBeNull();
    expect(await live(session)).toEqual(inOrder([0, 1, 2, 3, 10, 11]));
    expect(await tombstoned(session)).toEqual([4, 5, 6, 7].map(idOf));
    // The next turn writes on top: no seq is claimed twice.
    expect(await captureJournallessSessionLog(session, box(ROOT, msgs([0, 1, 2, 3, 10, 11, 12, 13])))).not.toBeNull();
    expect(await live(session)).toEqual(inOrder([0, 1, 2, 3, 10, 11, 12, 13]));
    // A tombstone is soft: the row stays, and a box that lists the message again revives it.
    expect(await captureJournallessSessionLog(session, box(ROOT, msgs([0, 1, 2, 3, 4, 10, 11, 12, 13])))).not.toBeNull();
    expect(await live(session)).toEqual(inOrder([0, 1, 2, 3, 4, 10, 11, 12, 13]));
    expect(await tombstoned(session)).toEqual([5, 6, 7].map(idOf));
  });

  test('nothing else tombstones: a partial read, a read that lacks only the newest messages, an empty complete read, a pi box', async () => {
    const session = await pinned();
    await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 8))));
    // A partial (tail) read that lacks 4..7 and lists 10: not the whole truth.
    expect(await captureJournallessSessionLog(session, box(ROOT, msgs([2, 3, 10]), false), { scope: 'tail' })).not.toBeNull();
    // A complete read with a hole (2 and 3 gone, 4..7 kept) and a new message: a box that lost files, not a rewind.
    await captureJournallessSessionLog(session, box(ROOT, msgs([0, 1, 4, 5, 6, 7, 10, 11])));
    // A complete read that lacks the newest messages and lists nothing newer: a box that lost them.
    await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 5))));
    // An empty complete read: lost box state, not an empty conversation.
    await captureJournallessSessionLog(session, box(ROOT, []));
    expect(await tombstoned(session)).toEqual([]);
    expect(await live(session)).toEqual(inOrder([...span(0, 8), 10, 11]));

    // pi has no rewind: its box never tombstones a stored row.
    const pi = await pinned(PI);
    await captureJournallessSessionLog(pi, box(PI, msgs(span(0, 8), PI)));
    await captureJournallessSessionLog(pi, box(PI, msgs([0, 1, 2, 3, 10, 11], PI)));
    expect(await tombstoned(pi)).toEqual([]);
    expect(await live(pi, PI)).toEqual(inOrder([...span(0, 8), 10, 11]));
  });

  test("a sub-agent's stored rows survive every later root read (a settled sub-agent is never read again)", async () => {
    const session = await pinned();
    const { root, child } = syntheticOpencodeSession({ root: ROOT, child: CHILD, turns: 6 });
    await captureJournallessSessionLog(session, box(ROOT, root, true, [{ id: CHILD, payload: child }]));
    const childRows = await live(session, CHILD);
    expect(childRows.length).toBe(child.length);
    const next = plain(9_000_000);
    await captureJournallessSessionLog(session, box(ROOT, [...root, next]));
    expect(await live(session, CHILD)).toEqual(childRows);
    expect(await tombstoned(session)).toEqual([]);
  });

  test('an old OpenCode build that answers the newest `limit` rows and no cursor: the walk is not complete, and nothing is tombstoned', async () => {
    const session = await pinned();
    const all = span(0, MIRROR_CAPTURE_LIMIT + 20);
    await captureJournallessSessionLog(session, box(ROOT, msgs(all)));
    // The box ignores paging: every read is the newest MIRROR_CAPTURE_LIMIT messages, with no `x-next-cursor`.
    const newest = [...all, 1_000, 1_001].slice(-MIRROR_CAPTURE_LIMIT);
    const oldBuild = {
      readMessages: async () => {
        const walk = await readTranscriptPages(async () => Response.json(msgs(newest)), true, undefined, MIRROR_CAPTURE_LIMIT);
        return { opencodeSessionId: ROOT, payload: walk.rows, headComplete: walk.headComplete, complete: walk.complete, children: [] };
      },
    };
    expect(await captureJournallessSessionLog(session, oldBuild)).not.toBeNull();
    expect(await tombstoned(session)).toEqual([]);
    expect((await live(session)).map(([id]) => id)).toEqual([...all, 1_000, 1_001].map(idOf));
  });

  test('a read of a root the session no longer runs writes nothing', async () => {
    const session = await pinned();
    await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 4))));
    await db.update(projectSessions).set({ runtimeSessionId: MOVED }).where(eq(projectSessions.sessionId, session));
    await captureJournallessSessionLog(session, box(MOVED, msgs([4, 5], MOVED)));
    // The new root's first read lacks every old-root row: a re-pin, not a rewind.
    expect(await tombstoned(session)).toEqual([]);
    const before = await logRows(session);
    // A capture that resolved the old root before the re-pin and writes after it.
    await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 4))));
    expect(await logRows(session)).toEqual(before);
    expect(await live(session)).toEqual(inOrder(span(0, 4)));
  });

  test('a capture over the size cap runs in a thread, never on the event loop; the real thread loads and answers', async () => {
    const session = await pinned();
    const cap = config.SESSION_LOG_RESTORE_MAX_BYTES;
    const handed: string[] = [];
    const deps = { ...box(ROOT, msgs(span(0, 12))), inThread: async (id: string) => (handed.push(id), { captured: -1, head_complete: false }) };
    config.SESSION_LOG_RESTORE_MAX_BYTES = 2_000;
    try {
      // No log yet: the box read is over the cap.
      expect(await captureJournallessSessionLog(session, deps)).toEqual({ captured: -1, head_complete: false });
      expect(handed).toEqual([session]);
      expect(await live(session)).toEqual([]);
      // A thread capture never hands off again: it writes.
      expect(await captureJournallessSessionLog(session, deps, { inThread: true })).toEqual({ captured: 12, head_complete: true });
      // A stored log over the cap hands off before it is read.
      handed.length = 0;
      await captureJournallessSessionLog(session, deps);
      expect(handed).toEqual([session]);
      // The real thread (live deps): this session has no box, so it answers null, and the API process lives on.
      const RealWorker = globalThis.Worker;
      const spawned: string[] = [];
      globalThis.Worker = class extends RealWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          spawned.push(String(url).split('/').pop()!);
        }
      };
      try {
        expect(await captureJournallessSessionLog(session)).toBeNull();
      } finally {
        globalThis.Worker = RealWorker;
      }
      expect(spawned).toEqual(['session-transcript-capture-thread.ts']);
    } finally {
      config.SESSION_LOG_RESTORE_MAX_BYTES = cap;
    }
    expect(await live(session)).toEqual(inOrder(span(0, 12)));
  });

  test('the capture thread has a memory guard and runs one at a time: no room defers the capture (one WARN, nothing stored, the next call retries)', async () => {
    const first = await pinned();
    const second = await pinned();
    await captureJournallessSessionLog(first, box(ROOT, msgs(span(0, 12))));
    await captureJournallessSessionLog(second, box(ROOT, msgs(span(0, 12))));
    const before = await logRows(first);
    const cap = config.SESSION_LOG_RESTORE_MAX_BYTES;
    const memory = config.SESSION_LOG_BACKFILL_MEMORY_MB;
    const RealWorker = globalThis.Worker;
    const spawned: string[] = [];
    let running = 0;
    let most = 0;
    globalThis.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        spawned.push(String(url).split('/').pop()!);
        most = Math.max(most, ++running);
      }
      override terminate() {
        running--;
        super.terminate();
      }
    };
    const warn = spyOn(logger, 'warn');
    config.SESSION_LOG_RESTORE_MAX_BYTES = 2_000;
    try {
      // No room: the process limit (1 MB) is under RSS alone.
      config.SESSION_LOG_BACKFILL_MEMORY_MB = 1;
      expect(await captureJournallessSessionLog(first)).toBeNull();
      expect(spawned).toEqual([]);
      const deferred = warn.mock.calls.filter(([line]) => String(line).startsWith('[session-log] capture deferred'));
      expect(deferred).toHaveLength(1);
      expect(deferred[0]![1]).toMatchObject({ session_id: first });
      expect(await logRows(first)).toEqual(before);
      // Room again: the next call runs, and two sessions' threads never run at once.
      config.SESSION_LOG_BACKFILL_MEMORY_MB = 1_000_000;
      expect(await Promise.all([captureJournallessSessionLog(first), captureJournallessSessionLog(second)])).toEqual([null, null]);
      expect(spawned).toEqual(['session-transcript-capture-thread.ts', 'session-transcript-capture-thread.ts']);
      expect(most).toBe(1);
    } finally {
      globalThis.Worker = RealWorker;
      warn.mockRestore();
      config.SESSION_LOG_RESTORE_MAX_BYTES = cap;
      config.SESSION_LOG_BACKFILL_MEMORY_MB = memory;
    }
  });

  test('no size cap: an over-cap first capture stores the whole history, and every later capture writes', async () => {
    const session = await pinned();
    const cap = config.SESSION_LOG_RESTORE_MAX_BYTES;
    config.SESSION_LOG_RESTORE_MAX_BYTES = 2_000;
    try {
      expect(await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 12))))).toEqual({ captured: 12, head_complete: true });
      expect(await live(session)).toEqual(inOrder(span(0, 12)));
      await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 14))));
      expect(await live(session)).toEqual(inOrder(span(0, 14)));
    } finally {
      config.SESSION_LOG_RESTORE_MAX_BYTES = cap;
    }
  });
});
