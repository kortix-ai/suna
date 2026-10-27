import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  accounts,
  projects,
  projectSessions,
  sessionLogMessages,
  sessionLogThreads,
  sessionLogs,
  sessionTranscriptMessages,
  sessionTranscriptMirrors,
} from '@kortix/db';
import { inArray } from 'drizzle-orm';

// `reply_count` read from the two transcript stores. Runs in the `db-suites`
// lane against a throwaway migrated database.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for the reply count suite');
process.env.DATABASE_URL = databaseUrl;
const { db } = await import('../../shared/db');
const { readSessionReplyCounts, replyCount } = await import('./session-reply-counts');

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const mirrorSession = crypto.randomUUID();
const logSession = crypto.randomUUID();
const emptySession = crypto.randomUUID();
const sessionIds = [mirrorSession, logSession, emptySession];

const at = (minute: number) => new Date(Date.UTC(2026, 9, 21, 10, minute));

async function mirrorRow(sessionId: string, messageId: string, role: string, parent: string | null, runtime: string, minute: number) {
  await db.insert(sessionTranscriptMessages).values({
    sessionId,
    messageId,
    parentMessageId: parent,
    runtimeSessionId: runtime,
    role,
    messageCreatedAt: at(minute),
    info: { id: messageId, role },
  });
}

let seq = 0;
async function logRow(
  messageId: string,
  role: string,
  record: Record<string, unknown>,
  extra: { threadId?: string; kind?: string; deletedAt?: Date } = {},
) {
  seq += 1;
  await db.insert(sessionLogMessages).values({
    sessionId: logSession,
    messageId,
    threadId: extra.threadId ?? 'root',
    seq,
    role,
    kind: extra.kind ?? 'turn',
    inContext: true,
    createdAt: at(seq),
    v: 1,
    producer: { harness: 'pi' },
    generation: 0,
    rev: seq,
    contentHash: messageId,
    deletedAt: extra.deletedAt ?? null,
    record: { message_id: messageId, role, ...record },
  });
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'reply-counts' });
  await db.insert(projects).values({ projectId, accountId, name: 'reply-counts', repoUrl: 'https://example.test/r.git' });
  await db.insert(projectSessions).values(
    sessionIds.map((sessionId) => ({
      sessionId,
      projectId,
      accountId,
      branchName: `session/${sessionId}`,
      status: 'running' as const,
    })),
  );

  // Mirror: two prompts, the first answered in two steps, the second in one,
  // and a sub-agent conversation under another runtime session.
  await db.insert(sessionTranscriptMirrors).values({ sessionId: mirrorSession, projectId, accountId, runtimeSessionId: 'ses_root' });
  await mirrorRow(mirrorSession, 'msg_u1', 'user', null, 'ses_root', 1);
  await mirrorRow(mirrorSession, 'msg_a1', 'assistant', 'msg_u1', 'ses_root', 2);
  await mirrorRow(mirrorSession, 'msg_a2', 'assistant', 'msg_u1', 'ses_root', 3);
  await mirrorRow(mirrorSession, 'msg_u2', 'user', null, 'ses_root', 4);
  await mirrorRow(mirrorSession, 'msg_a3', 'assistant', 'msg_u2', 'ses_root', 5);
  await mirrorRow(mirrorSession, 'msg_cu', 'user', null, 'ses_child', 6);
  await mirrorRow(mirrorSession, 'msg_ca', 'assistant', 'msg_cu', 'ses_child', 7);

  // Session log: a prompt answered in two steps, a steer answered once, and
  // rows that are not replies: an automation prompt, a hidden failed attempt,
  // a tombstone, a compaction and a sub-agent thread. A mirror copy of the
  // same session is ignored: the log wins.
  await db.insert(sessionLogs).values({
    sessionId: logSession, projectId, accountId, v: 1, harnessCurrent: 'pi', restoreGrade: 'full', record: {},
  });
  await db.insert(sessionLogThreads).values([
    { sessionId: logSession, threadId: 'root', parentThreadId: null, v: 1, record: {} },
    { sessionId: logSession, threadId: 'child', parentThreadId: 'root', v: 1, record: {} },
  ]);
  await logRow('u1', 'user', { origin: 'prompt' });
  await logRow('a1', 'assistant', { reply_to: 'u1' });
  await logRow('a2', 'assistant', { reply_to: 'u1' });
  await logRow('u2', 'user', { origin: 'steer' });
  await logRow('a3', 'assistant', { reply_to: 'u2' });
  await logRow('u3', 'user', { origin: 'automation' });
  await logRow('a4', 'assistant', { reply_to: 'u9', hidden_reason: 'failed_attempt' });
  await logRow('a5', 'assistant', { reply_to: 'u8' }, { deletedAt: at(50) });
  await logRow('c1', 'assistant', { reply_to: 'u1' }, { kind: 'compaction' });
  await logRow('s1', 'user', { origin: 'prompt' }, { threadId: 'child' });
  await logRow('s2', 'assistant', { reply_to: 's1' }, { threadId: 'child' });
  await db.insert(sessionTranscriptMirrors).values({ sessionId: logSession, projectId, accountId, runtimeSessionId: 'ses_log' });
  await mirrorRow(logSession, 'msg_x1', 'user', null, 'ses_log', 1);
});

afterAll(async () => {
  await db.delete(projectSessions).where(inArray(projectSessions.sessionId, sessionIds));
  await db.delete(projects).where(inArray(projects.projectId, [projectId]));
  await db.delete(accounts).where(inArray(accounts.accountId, [accountId]));
});

test('replies are the person messages after the first plus one answer per answered message', () => {
  expect(replyCount(1, 1)).toBe(1);
  expect(replyCount(2, 2)).toBe(3);
  expect(replyCount(1, 0)).toBe(0);
  expect(replyCount(0, 0)).toBe(0);
});

test('the mirror counts the root conversation: 1 follow-up + 2 answers, sub-agent rows excluded', async () => {
  const counts = await readSessionReplyCounts(sessionIds);
  expect(counts.get(mirrorSession)).toBe(3);
});

test('the session log wins over the mirror and drops automation, hidden, deleted, compaction and sub-agent rows', async () => {
  const counts = await readSessionReplyCounts(sessionIds);
  expect(counts.get(logSession)).toBe(3);
});

test('a session with no transcript store answers 0', async () => {
  const counts = await readSessionReplyCounts(sessionIds);
  expect(counts.get(emptySession)).toBe(0);
  expect((await readSessionReplyCounts([])).size).toBe(0);
});
