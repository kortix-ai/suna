import { expect, test } from 'bun:test';
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { seedProject, seedSession, removeSeeded, localTestDatabaseUrl } from '../../__tests__/helpers/integration-fixtures';
import { storeSessionModelSwitch } from './session-model-switch-store';

test('concurrent retry stores one continuation and refuses a changed payload', async () => {
  localTestDatabaseUrl();
  const project = await seedProject('model-switch');
  const actor = crypto.randomUUID();
  const sessionId = await seedSession(project, actor);
  const input = { projectId: project.project_id, accountId: project.account_id, sessionId,
    actorUserId: actor, actorSessionId: sessionId, model: 'kortix/synthetic-model', prompt: 'Continue verification', key: 'retry-1' };
  try {
    const results = await Promise.all([storeSessionModelSwitch(input), storeSessionModelSwitch(input)]);
    expect(results.filter((result) => result.kind === 'stored' && !result.deduped)).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'stored' && result.deduped)).toHaveLength(1);
    expect(await storeSessionModelSwitch({ ...input, prompt: 'Changed request' })).toEqual({ kind: 'conflict' });
    const [session] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId));
    expect(session?.metadata?.model).toBe(input.model);
    expect(session?.metadata?.model_switches).toMatchObject([{ to: input.model, prompt: input.prompt, actor_session_id: sessionId }]);
    const rows = await db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ delivery: 'queue', modelSwitch: { from: null, to: input.model, actorSessionId: sessionId, prompt: input.prompt } });
    expect((await storeSessionModelSwitch({ ...input, key: 'retry-2' })).kind).toBe('stored');
    expect((await storeSessionModelSwitch({ ...input, key: 'retry-3' })).kind).toBe('stored');
    expect(await storeSessionModelSwitch({ ...input, key: 'retry-4' })).toEqual({ kind: 'limited' });
    expect((await storeSessionModelSwitch(input)).kind).toBe('stored');
    // A human plain set is audited/history-recorded but creates no runnable prompt.
    const human = { ...input, actorSessionId: null, prompt: undefined, key: 'human-set', model: 'kortix/newer' };
    expect((await storeSessionModelSwitch(human)).kind).toBe('stored');
    const retry = await storeSessionModelSwitch(input);
    expect(retry).toMatchObject({ kind: 'stored', deduped: true, model: human.model, needsPush: false });
    const [latest] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId));
    expect(latest?.metadata?.model).toBe(human.model);
    const [plain] = await db.select().from(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.idempotencyKey, `model-switch:${sessionId}:human-set`));
    expect(plain?.status).toBe('succeeded');
    await db.update(projectSessions).set({ status: 'running' }).where(eq(projectSessions.sessionId, sessionId));
    const failedPush = await storeSessionModelSwitch({ ...human, key: 'throwing-push', model: 'kortix/after-error',
      push: async () => { throw new Error('synthetic transport failure'); } });
    expect(failedPush).toMatchObject({ kind: 'stored', push: { applied: false } });
    const [afterError] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, sessionId));
    expect(afterError?.metadata?.model).toBe('kortix/after-error');

  } finally {
    await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, sessionId));
    await db.delete(projectSessions).where(eq(projectSessions.sessionId, sessionId));
    await removeSeeded([project]);
  }
});
