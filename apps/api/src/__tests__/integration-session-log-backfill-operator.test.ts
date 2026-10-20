import { afterAll, expect, test } from 'bun:test';
import { sessionTranscriptMirrors, sessionTranscriptMessages, sessionLogs } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { backfillSessionLogs, newBackfillState } from '../projects/session-log-backfill';
import { seedProject, seedSession, removeSeeded } from './helpers/integration-fixtures';

const project = await seedProject('backfill-operator');
afterAll(() => removeSeeded([project]));

test('an ephemeral dry pass ignores durable completion, paginates, writes nothing and can run again', async () => {
  const sessionId = await seedSession(project, crypto.randomUUID());
  for (const id of [sessionId, await seedSession(project, crypto.randomUUID())]) {
    await db.insert(sessionTranscriptMirrors).values({ sessionId: id, projectId: project.project_id, accountId: project.account_id, runtimeSessionId: 'ses_operator' });
    await db.insert(sessionTranscriptMessages).values({ sessionId: id, messageId: 'msg_operator', runtimeSessionId: 'ses_operator', role: 'user', info: { id: 'msg_operator', sessionID: 'ses_operator', role: 'user', time: { created: 1000 } }, parts: [{ id: 'prt_operator', messageID: 'msg_operator', sessionID: 'ses_operator', type: 'text', text: 'synthetic' }] });
  }
  // The background worker completed this build already. The operator must not reuse its cursor.
  await backfillSessionLogs('dry');
  const before = await db.execute(sql`select * from kortix.session_log_backfill_state`);
  for (let run = 0; run < 2; run++) {
    const state = newBackfillState('dry');
    const first = await backfillSessionLogs('dry', { state, budgetMs: 0 });
    expect(first).toMatchObject({ more: true, counts: { sessions: 1, logs: 1, failed: 0 } });
    const last = await backfillSessionLogs('dry', { state });
    expect(last).toMatchObject({ more: false, counts: { sessions: 1, logs: 1 } });
    expect(state.dryDone).toBe(true);
    expect(await db.execute(sql`select * from kortix.session_log_backfill_state`)).toEqual(before);
    expect(await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId))).toEqual([]);
  }
});
