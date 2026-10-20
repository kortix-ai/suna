import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { projectSessions, sessionLogs, sessionLogThreads, sessionLogMessages, sessionLogBlobs, sessionSandboxes, accountMembers, projectMembers } from '@kortix/db';
import { insertIntoView } from './helpers/compat-views';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { localTestDatabaseUrl, seedProject, seedSession, removeSeeded, type SeededProject } from './helpers/integration-fixtures';
localTestDatabaseUrl();
const bucket = fakeSessionStorage();
const real = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...real, getSupabase: () => ({ storage: bucket.storage }) }));
const { copySessionLog } = await import('../projects/session-log-fork');
let project: SeededProject;
let sourceId: string;
let destination: string;
const root = 'synthetic-root';
const attachment = crypto.randomUUID();
beforeAll(async () => {
  project = await seedProject('synthetic-fork');
  sourceId = await seedSession(project, crypto.randomUUID());
  destination = await seedSession(project, crypto.randomUUID());
  const key = `${project.project_id}/${sourceId}/${attachment}`;
  bucket.objects.set(key, new Blob(['independent history'], { type: 'text/plain' }));
  await db.insert(sessionLogs).values({ sessionId: sourceId, projectId: project.project_id, accountId: project.account_id, v: 1, harnessCurrent: 'opencode', restoreGrade: 'native', journalSeenAt: new Date(), record: { session_id: sourceId, title: 'Synthetic conversation' } });
  await db.insert(sessionLogThreads).values({ sessionId: sourceId, threadId: root, v: 1, record: { thread_id: root, parent_thread_id: null } });
  await db.insert(sessionLogMessages).values({ sessionId: sourceId, messageId: 'synthetic-message', threadId: root, seq: 1, role: 'user', kind: 'message', inContext: true, createdAt: new Date(), v: 1, producer: {}, generation: 0, rev: 1, contentHash: 'synthetic', record: { text: 'keep history', ref: `kortix-attachment://${key}` } });
  await db.insert(sessionLogBlobs).values({ sessionId: sourceId, sha256: 'synthetic-hash', objectKey: key, bytes: 19, mime: 'text/plain' });
});
afterAll(async () => { await removeSeeded([project]); });
test('fork preserves root and messages and owns attachments even after source deletion', async () => {
  await db.transaction((tx) => copySessionLog(tx, { sourceId, sessionId: destination, projectId: project.project_id, accountId: project.account_id }));
  const [thread] = await db.select().from(sessionLogThreads).where(eq(sessionLogThreads.sessionId, destination));
  expect(thread?.threadId).toBe(root);
  const [message] = await db.select().from(sessionLogMessages).where(eq(sessionLogMessages.sessionId, destination));
  const key = `${project.project_id}/${destination}/${attachment}`;
  expect(message?.record).toEqual({ text: 'keep history', ref: `kortix-attachment://${key}` });
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, sourceId));
  bucket.objects.delete(`${project.project_id}/${sourceId}/${attachment}`);
  expect(await bucket.objects.get(key)?.text()).toBe('independent history');
  expect(await db.select().from(sessionLogMessages).where(eq(sessionLogMessages.sessionId, destination))).toHaveLength(1);
});
test('a foreign project source cannot be copied and failed copy rolls back', async () => {
  await expect(db.transaction((tx) => copySessionLog(tx, { sourceId: destination, sessionId: crypto.randomUUID(), projectId: crypto.randomUUID(), accountId: project.account_id }))).rejects.toThrow('Fork source not found');
  expect(await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, destination))).toHaveLength(1);
});

test('restore kill switch refuses fork without writing a destination log', async () => {
  const { config } = await import('../config');
  const enabled = config.SESSION_LOG_RESTORE_ENABLED;
  config.SESSION_LOG_RESTORE_ENABLED = false;
  try {
    await expect(db.transaction((tx) => copySessionLog(tx, { sourceId: destination, sessionId: crypto.randomUUID(), projectId: project.project_id, accountId: project.account_id }))).rejects.toThrow('Session log restore is off');
  } finally { config.SESSION_LOG_RESTORE_ENABLED = enabled; }
});


test('HTTP create refuses private, foreign, deleted and missing fork sources before provisioning', async () => {
  const { app } = await import('../index');
  const { createAccountToken } = await import('../repositories/account-tokens');
  const member = crypto.randomUUID();
  await insertIntoView(db, accountMembers, { userId: member, accountId: project.account_id, accountRole: 'member' });
  await insertIntoView(db, projectMembers, { userId: member, accountId: project.account_id, projectId: project.project_id, projectRole: 'member' });
  const token = (await createAccountToken({ accountId: project.account_id, userId: member, name: 'synthetic-fork-member' })).secretKey;
  const own = await seedSession(project, member);
  const foreign = await seedProject('synthetic-foreign-fork');
  try {
    const foreignSource = await seedSession(foreign, member);
    const deleted = await seedSession(project, member);
    await db.update(projectSessions).set({ metadata: { deletedAt: new Date().toISOString() } }).where(eq(projectSessions.sessionId, deleted));
    for (const id of [destination, foreignSource, deleted, crypto.randomUUID()]) {
      const response = await app.request(`/v1/projects/${project.project_id}/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fork_from_session_id: id }) });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'Not found' });
    }
    await db.update(projectSessions).set({ status: 'running', origin: 'backend' }).where(eq(projectSessions.sessionId, own));
    await db.insert(sessionSandboxes).values({ sandboxId: own, sessionId: own, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
    const scoped = (await createAccountToken({ accountId: project.account_id, userId: member, projectId: project.project_id, sessionId: own, name: 'synthetic-fork-bound' })).secretKey;
    const sibling = await seedSession(project, member);
    await db.update(projectSessions).set({ origin: 'backend' }).where(eq(projectSessions.sessionId, sibling));
    const response = await app.request(`/v1/projects/${project.project_id}/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${scoped}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fork_from_session_id: sibling }) });
    expect(response.status).toBe(404);
  } finally {
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, project.account_id));
    await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
    await removeSeeded([foreign]);
  }
});

test('running source without a journal or successful full capture is refused', async () => {
  await db.update(projectSessions).set({ status: 'running', origin: 'backend' }).where(eq(projectSessions.sessionId, destination));
  await expect(db.transaction((tx) => copySessionLog(tx, { sourceId: destination, sessionId: crypto.randomUUID(), projectId: project.project_id, accountId: project.account_id }))).rejects.toThrow('Source history capture is incomplete');
});

test('stopped partial history without a completed capture is refused too', async () => {
  await db.update(projectSessions).set({ status: 'stopped' }).where(eq(projectSessions.sessionId, destination));
  await expect(db.transaction((tx) => copySessionLog(tx, { sourceId: destination, sessionId: crypto.randomUUID(), projectId: project.project_id, accountId: project.account_id }))).rejects.toThrow('Source history capture is incomplete');
});

test('failed fork transaction removes destination uploads but leaves source bytes', async () => {
  const { withForkAttachmentCleanup } = await import('../projects/session-log-fork');
  const target = crypto.randomUUID();
  const key = `${project.project_id}/${destination}/${attachment}`;
  const copiedKey = `${project.project_id}/${target}/${attachment}`;
  await db.update(sessionLogs).set({ journalSeenAt: new Date() }).where(eq(sessionLogs.sessionId, destination));
  await expect(withForkAttachmentCleanup(project.project_id, target, async () => db.transaction(async (tx) => {
    await tx.insert(projectSessions).values({ sessionId: target, accountId: project.account_id, projectId: project.project_id, branchName: target });
    await copySessionLog(tx, { sourceId: destination, sessionId: target, projectId: project.project_id, accountId: project.account_id });
    expect(bucket.objects.has(copiedKey)).toBe(true);
    throw new Error('synthetic failure after upload');
  }))).rejects.toThrow('synthetic failure after upload');
  expect(bucket.objects.has(copiedKey)).toBe(false);
  expect(await bucket.objects.get(key)?.text()).toBe('independent history');
  expect(await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, target))).toHaveLength(0);
});
