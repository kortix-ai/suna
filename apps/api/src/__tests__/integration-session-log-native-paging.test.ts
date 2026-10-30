/**
 * Integration test (real PostgreSQL, fresh migrated database, real routes): the v1 window over a
 * native (pi) thread pages by `seq`, its append order. Two messages created in the same
 * millisecond whose ids sort against their seqs sit on a page boundary. Every session is synthetic.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromV1, type SessionLogJournalRequest, type V1Row } from '@kortix/api-contract/session-log';
import { accountMembers, projectSessions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { ingestSessionLogJournal } = await import('../projects/session-log-ingest');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_pi00000000000000000000aa';
const REV = 1_791_681_474_704_000;
let project: SeededProject;
let token = '';

const row = (n: number): V1Row => {
  const id = `msg_${String(n).padStart(6, '0')}`;
  const created = 1_790_000_000_000 + n * 1000;
  const info =
    n % 2 === 0
      ? { id, sessionID: ROOT, role: 'user', time: { created }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' } }
      : { id, sessionID: ROOT, role: 'assistant', parentID: `msg_${String(n - 1).padStart(6, '0')}`, time: { created, completed: created + 500 }, providerID: 'kortix', modelID: 'm', finish: 'stop' };
  return { runtime_session_id: ROOT, info, parts: [{ id: `prt_${n}`, sessionID: ROOT, messageID: id, type: 'text', text: `reply ${n}` }] } as unknown as V1Row;
};

beforeAll(async () => {
  project = await seedProject('session-log-native-paging');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  token = (await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'session-log-native-paging' })).secretKey;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
  await removeSeeded([project]);
});

test('a native thread pages by seq: a same-millisecond pair on a page boundary is served once each, in seq order', async () => {
  const session = await seedSession(project, OWNER);
  await db.update(projectSessions).set({ runtimeSessionId: ROOT }).where(eq(projectSessions.sessionId, session));
  // Ten messages as the pi adapter journals them: native thread and records (no v1 ext), seq = append order.
  const log = fromV1({ session_id: session, root_id: ROOT, rows: Array.from({ length: 10 }, (_, n) => row(n)) }, { harness: 'pi' });
  const [thread] = log.threads;
  delete thread!.ext;
  for (const m of thread!.messages) {
    delete m.ext;
    for (const b of m.blocks) delete (b as { ext?: unknown }).ext;
  }
  // seq 6 is appended after seq 5 in the same millisecond, with an id that sorts before seq 5's.
  const [five, six] = [thread!.messages[4]!, thread!.messages[5]!];
  six.created_at = five.created_at;
  six.message_id = 'msg_000003z';
  const producer = { harness: 'pi', harness_version: '1.2.0', adapter_version: '1.0.0' };
  const { threads, ...patch } = log;
  const batch: SessionLogJournalRequest = {
    generation: 0,
    session: patch,
    threads: threads.map(({ messages: _m, ...t }) => t),
    puts: threads.flatMap((t) => t.messages.map((m, i) => ({ rev: REV + i, message: { ...m, producer } }))),
    tombstones: [],
  };
  expect((await ingestSessionLogJournal({ sessionId: session, projectId: project.project_id, accountId: project.account_id }, batch)).status).toBe(200);
  const bySeq = thread!.messages.map((m) => m.message_id);

  const served: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const res = await app.request(`/v1/projects/${project.project_id}/sessions/${session}/transcript?shape=sync&limit=5${cursor ? `&before=${cursor}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { next_cursor: string | null; messages: Array<{ info: { id: string } }> };
    served.unshift(...body.messages.map((m) => m.info.id));
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  expect(served).toEqual(bySeq);
});
