import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projects, projectSessions, sessionLogs, sessionLogThreads, sessionLogMessages, sessionTranscriptMirrors, sessionTranscriptMessages, gatewayRequestLogs } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { loadProjectSessionInventory } from '../projects/lib/session-list';
import { serializeSession } from '../projects/lib/serializers';

const account = crypto.randomUUID();
const project = crypto.randomUUID();
const viewer = crypto.randomUUID();
const session = crypto.randomUUID();
const at = new Date();
beforeAll(async () => {
  await db.insert(accounts).values({ accountId: account, name: 'model-list-regression' });
  await db.insert(projects).values({ projectId: project, accountId: account, name: 'model-list', repoUrl: 'https://example.test/repo.git' });
  await db.insert(projectSessions).values({ sessionId: session, accountId: account, projectId: project, branchName: 'test', createdBy: viewer, metadata: { opencode_model: 'kortix/deepseek-v4.1-flash', opencode_model_source: 'platform' } });
  await db.insert(sessionLogs).values({ sessionId: session, projectId: project, accountId: account, v: 1, harnessCurrent: 'pi', restoreGrade: 'native', record: {} });
  await db.insert(sessionLogThreads).values({ sessionId: session, threadId: 'main', v: 1, record: {} });
  await db.insert(sessionLogMessages).values({ sessionId: session, threadId: 'main', messageId: 'answer', seq: 1, role: 'assistant', kind: 'turn', inContext: true, createdAt: at, v: 1, producer: {}, generation: 0, rev: 1, contentHash: 'synthetic', record: { model: { provider: 'kortix', model: 'glm-5.3-flash' } } });
});
afterAll(async () => { await db.delete(accounts).where(eq(accounts.accountId, account)); });
test('list reports the conversation model rather than its stale creation default, without changing the pin', async () => {
  const inventory = await loadProjectSessionInventory({ projectId: project, accountId: account, userId: viewer, scope: 'visible', boundCredentialSessionId: null, probeManageCapability: async () => false });
  const item = inventory.items.find((item) => item.row.sessionId === session);
  expect(item).toBeDefined();
  const wire = serializeSession(item!.row, { trimListMetadata: true });
  expect(wire).toHaveProperty('model', 'kortix/glm-5.3-flash');
  expect(wire.metadata.opencode_model).toBe('kortix/deepseek-v4.1-flash');
});

test('an unprompted session reports its project-default pin', async () => {
  const id = crypto.randomUUID();
  await db.insert(projectSessions).values({ sessionId: id, accountId: account, projectId: project, branchName: 'unprompted', createdBy: viewer, metadata: { opencode_model: 'kortix/glm-5.3-flash', opencode_model_source: 'project' } });
  const inventory = await loadProjectSessionInventory({ projectId: project, accountId: account, userId: viewer, scope: 'visible', boundCredentialSessionId: null, probeManageCapability: async () => false });
  const item = inventory.items.find((item) => item.row.sessionId === id);
  expect(item).toBeDefined();
  expect(serializeSession(item!.row, { trimListMetadata: true })).toHaveProperty('model', 'kortix/glm-5.3-flash');
});

test('a tombstoned answer and a subagent cannot replace the root conversation model', async () => {
  await db.insert(sessionLogThreads).values({ sessionId: session, threadId: 'child', parentThreadId: 'main', v: 1, record: {} });
  for (const [id, threadId, deletedAt] of [['child-answer', 'child', null], ['removed-answer', 'main', new Date()]] as const) {
    await db.insert(sessionLogMessages).values({ sessionId: session, threadId, messageId: id, seq: 2, role: 'assistant', kind: 'turn', inContext: true, createdAt: new Date(at.getTime() + 1000), v: 1, producer: {}, generation: 0, rev: 2, contentHash: 'synthetic', deletedAt, record: { model: { provider: 'kortix', model: 'other-model' } } });
  }
  const inventory = await loadProjectSessionInventory({ projectId: project, accountId: account, userId: viewer, scope: 'visible', boundCredentialSessionId: null, probeManageCapability: async () => false });
  const item = inventory.items.find((item) => item.row.sessionId === session);
  expect(item).toBeDefined();
  expect(serializeSession(item!.row)).toHaveProperty('model', 'kortix/glm-5.3-flash');
  expect(serializeSession(item!.row, { canAccess: false }).model).toBeNull();
});


test('legacy mirror reports the root assistant model, not a newer child conversation', async () => {
  const id = crypto.randomUUID();
  await db.insert(projectSessions).values({ sessionId: id, accountId: account, projectId: project, branchName: 'legacy', runtimeSessionId: 'root', createdBy: viewer, metadata: { opencode_model: 'kortix/deepseek-v4.1-flash' } });
  await db.insert(sessionTranscriptMirrors).values({ sessionId: id, projectId: project, accountId: account });
  for (const runtime of ['root', 'child']) {
    await db.insert(sessionTranscriptMessages).values({ sessionId: id, messageId: runtime, runtimeSessionId: runtime, role: 'assistant', messageCreatedAt: new Date(at.getTime() + (runtime === 'child' ? 1000 : 0)), info: { providerID: 'kortix', modelID: runtime === 'root' ? 'glm-5.3-flash' : 'other-model' } });
  }
  const inventory = await loadProjectSessionInventory({ projectId: project, accountId: account, userId: viewer, scope: 'visible', boundCredentialSessionId: null, probeManageCapability: async () => false });
  const item = inventory.items.find((item) => item.row.sessionId === id);
  expect(item).toBeDefined();
  expect(serializeSession(item!.row)).toHaveProperty('model', 'kortix/glm-5.3-flash');
});


test('a successful gateway fallback outranks the requested transcript model', async () => {
  await db.insert(gatewayRequestLogs).values({ requestId: 'synthetic-fallback', sessionId: session, accountId: account, projectId: project, requestedModel: 'glm-5.3-flash', resolvedModel: 'deepseek-v4.1-flash', provider: 'kortix', status: 200, ok: true, metadata: { servedModel: 'deepseek-v4.1-flash', fallbackFrom: 'glm-5.3-flash' } });
  const inventory = await loadProjectSessionInventory({ projectId: project, accountId: account, userId: viewer, scope: 'visible', boundCredentialSessionId: null, probeManageCapability: async () => false });
  const item = inventory.items.find((item) => item.row.sessionId === session);
  expect(item).toBeDefined();
  expect(serializeSession(item!.row)).toHaveProperty('model', 'kortix/deepseek-v4.1-flash');
});
