/**
 * Integration test (real PostgreSQL, fresh migrated database): the capture of a box without a
 * journal (`writeSessionLogFromRead`, `session-log-capture.ts`) on a rewound, re-pinned or large
 * box. Every session here is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, projectSessions, sessionLogMessages } from '@kortix/db';
import { asc, eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { syntheticOpencodeSession } from './helpers/synthetic-opencode-session';

const { captureJournallessSessionLog } = await import('../projects/lib/session-transcript-capture');

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
  });

  test('nothing else tombstones: a partial read, a read that lacks only the newest messages, an empty complete read, a pi box', async () => {
    const session = await pinned();
    await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 8))));
    // A partial (tail) read that lacks 4..7 and lists 10: not the whole truth.
    expect(await captureJournallessSessionLog(session, box(ROOT, msgs([2, 3, 10]), false), { scope: 'tail' })).not.toBeNull();
    // A complete read that lacks the newest messages and lists nothing newer: a box that lost them.
    await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 5))));
    // An empty complete read: lost box state, not an empty conversation.
    await captureJournallessSessionLog(session, box(ROOT, []));
    expect(await tombstoned(session)).toEqual([]);
    expect(await live(session)).toEqual(inOrder([...span(0, 8), 10]));

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

  test('a read of a root the session no longer runs writes nothing', async () => {
    const session = await pinned();
    await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 4))));
    await db.update(projectSessions).set({ runtimeSessionId: MOVED }).where(eq(projectSessions.sessionId, session));
    await captureJournallessSessionLog(session, box(MOVED, msgs([4, 5], MOVED)));
    const before = await logRows(session);
    // A capture that resolved the old root before the re-pin and writes after it.
    await captureJournallessSessionLog(session, box(ROOT, msgs(span(0, 4))));
    expect(await logRows(session)).toEqual(before);
    expect(await live(session)).toEqual(inOrder(span(0, 4)));
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
