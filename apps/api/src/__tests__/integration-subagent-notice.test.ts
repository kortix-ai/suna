/**
 * Integration test (real local PostgreSQL): a background subagent's finished
 * turn becomes ONE durable message in its parent session, and nothing else
 * does (`projects/subagent-notice.ts`).
 *
 * Real: the session rows, the parent link check, the settled check (the
 * child's inbox and its own background children, `readSessionsWorking`) and
 * the `continue_session` insert with its idempotency key. Stubbed: the box
 * (`buildSessionTranscriptDigest` answers a fixed transcript) and the drain
 * kick (a no-op: delivery is the lifecycle engine's own contract).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realTranscript from '../projects/lib/session-transcript';
import * as realDrain from '../projects/session-lifecycle/drain';

let transcript: Array<Record<string, unknown>> = [];
mock.module('../projects/lib/session-transcript', () => ({
  ...realTranscript,
  buildSessionTranscriptDigest: async () => ({ available: true, reason: null, source: 'live', complete: true, messages: transcript }),
}));
mock.module('../projects/session-lifecycle/drain', () => ({
  ...realDrain,
  drainSessionLifecycleQueue: async () => undefined,
}));

const { db } = await import('../shared/db');
const { notifyParentOfFailedStart, notifyParentOfLostTurn, notifyParentOfSubagentTurn, stoppedSubagentNotice } = await import('../projects/subagent-notice');
const { notifyTurnLost } = await import('../shared/turn-lost-notifier');
const { enqueueContinueSessionCommand } = await import('../projects/session-lifecycle/store');

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const AUTHOR = crypto.randomUUID();
const PARENT = crypto.randomUUID();
const CHILD = crypto.randomUUID();
const msg = (role: string, text: string, error: unknown = null) => ({ id: null, parent_id: null, role, created: null, completed: null, text, tools: [], files: [], reasoning_omitted: false, error });

async function insertSession(sessionId: string, opts: { parent?: string; metadata?: Record<string, unknown>; status?: string } = {}) {
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status, created_by, agent_name, parent_session_id, metadata)
    VALUES (${sessionId}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${sessionId}`}, ${opts.status ?? 'running'}, ${AUTHOR}::uuid, 'reviewer',
      ${opts.parent ?? null}, ${JSON.stringify(opts.metadata ?? {})}::jsonb)`);
}

async function parentRows() {
  const result = await db.execute(sql`
    SELECT source, idempotency_key, actor_user_id, payload FROM kortix.session_lifecycle_commands
    WHERE session_id = ${PARENT} AND command_type = 'continue_session' ORDER BY created_at`);
  return ((result as { rows?: unknown[] }).rows ?? result) as Array<{ source: string; idempotency_key: string; actor_user_id: string | null; payload: Record<string, any> }>;
}

const background = { notify_parent: true, spawned_by_session: PARENT, custom_name: 'Audit logs' };

beforeAll(async () => {
  await db.execute(sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'subagent-notice-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'subagent-notice-it', 'https://example.invalid/r.git')`);
  await insertSession(PARENT, { status: 'stopped' });
});

beforeEach(async () => {
  transcript = [msg('user', 'audit the logs'), msg('assistant', 'Reading the logs.'), msg('assistant', 'Found 2 errors in api.log.')];
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE project_id = ${PROJECT_ID}::uuid`);
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE project_id = ${PROJECT_ID}::uuid AND session_id <> ${PARENT}`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE project_id = ${PROJECT_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE project_id = ${PROJECT_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`).catch(() => undefined);
});

describe('a background subagent turn end', () => {
  test('writes one steer message into the parent with the child id, status and report; the same turn again writes nothing', async () => {
    await insertSession(CHILD, { parent: PARENT, metadata: background });
    expect(await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'idle', turnMessageId: 'msg_turn_1' })).toBe(true);
    expect(await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'idle', turnMessageId: 'msg_turn_1' })).toBe(false);

    const rows = await parentRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.source).toBe('system:subagent-finished');
    expect(row!.idempotency_key).toBe(`subagent-finished:${CHILD}:msg_turn_1`);
    // The identity the child ran as, never a person who did not send it.
    expect(row!.actor_user_id).toBe(AUTHOR);
    expect(row!.payload).toMatchObject({ delivery: 'steer', placement: 'composer', authorSessionId: CHILD, clientMessageId: row!.idempotency_key });
    const text = row!.payload.text as string;
    expect(row!.payload.parts).toEqual([{ type: 'text', text, synthetic: true }]);
    expect(text).toBe([
      'A background subagent you started has finished. This message is from the platform, not from the user.',
      `task_id: ${CHILD}`,
      'status: completed',
      '',
      // The element the web transcript draws as the "Worker complete" card.
      '<kortix_system type="session-report" source="subagent">',
      '<session-report>',
      `<session-id>${CHILD}</session-id>`,
      '<status>COMPLETE</status>',
      '<project>reviewer</project>',
      '<prompt>Audit logs</prompt>',
      '<result>\n<task_result>\nFound 2 errors in api.log.\n</task_result>\n</result>',
      '</session-report>',
      '</kortix_system>',
      '',
      `Continue your task with this result. To send this subagent a follow-up, call \`agent\` with task_id ${CHILD}. To read its whole transcript: \`kortix sessions log ${CHILD}\`.`,
    ].join('\n'));

    // A later turn of the same child (a follow-up) is a new event. While the
    // first notice still waits, the second joins its row: one delivery.
    transcript = [...transcript, msg('user', 'and the tests?'), msg('assistant', 'Tests pass.')];
    expect(await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'idle', turnMessageId: 'msg_turn_2' })).toBe(true);
    const [joined, ...rest] = await parentRows();
    expect(rest).toHaveLength(0);
    expect(joined!.payload.noticeKeys).toEqual([`subagent-finished:${CHILD}:msg_turn_1`, `subagent-finished:${CHILD}:msg_turn_2`]);
    expect((joined!.payload.text as string).startsWith(`${text}\n\n`)).toBe(true);
    expect(joined!.payload.parts).toEqual([{ type: 'text', text: joined!.payload.text, synthetic: true }]);
    expect(joined!.payload.text).toContain('<task_result>\nTests pass.\n</task_result>');
    // A repeat of the second notice's key inserts nothing either.
    expect(await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'idle', turnMessageId: 'msg_turn_2' })).toBe(false);
  });

  test('an error turn reports error with its cause; a stopped turn reports stopped', async () => {
    await insertSession(CHILD, { parent: PARENT, metadata: background });
    transcript = [msg('user', 'go'), msg('assistant', '', { name: 'APIError', message: 'model overloaded' })];
    await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'error', errorInfo: { name: 'APIError', message: 'model overloaded' }, turnMessageId: 'msg_e' });
    await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'error', errorInfo: { name: 'MessageAbortedError', message: 'aborted' }, turnMessageId: 'msg_s' });
    // Both notices wait together, so they are one row: error first, then stopped.
    const [both] = (await parentRows()).map((r) => r.payload.text as string);
    const [error, stopped] = both!.split('\n\nA background subagent you started has finished.');
    expect(error).toContain('status: error\n');
    expect(error).toContain('<status>FAILED</status>');
    expect(error).toContain('<task_error>\nAPIError: model overloaded\n</task_error>');
    expect(stopped).toContain('status: stopped\n');
  });

  test('a child that still waits on its own background child, or a parent link the server did not write, writes nothing', async () => {
    await insertSession(CHILD, { parent: PARENT, metadata: background });
    const grandchild = crypto.randomUUID();
    await insertSession(grandchild, { parent: CHILD, metadata: { notify_parent: true, spawned_by_session: CHILD }, status: 'provisioning' });
    expect(await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'idle', turnMessageId: 'msg_wait' })).toBe(false);
    // The grandchild settles: the child's next turn end is its finish.
    await db.execute(sql`UPDATE kortix.project_sessions SET status = 'stopped' WHERE session_id = ${grandchild}`);
    expect(await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'idle', turnMessageId: 'msg_done' })).toBe(true);

    // A foreground child, and a child whose parent is not its spawner, never notify.
    const foreground = crypto.randomUUID();
    await insertSession(foreground, { parent: PARENT, metadata: { spawned_by_session: PARENT } });
    const forged = crypto.randomUUID();
    await insertSession(forged, { parent: PARENT, metadata: { notify_parent: true } });
    expect(await notifyParentOfSubagentTurn({ sessionId: foreground, status: 'idle', turnMessageId: 'm' })).toBe(false);
    expect(await notifyParentOfSubagentTurn({ sessionId: forged, status: 'idle', turnMessageId: 'm' })).toBe(false);
    expect((await parentRows()).map((r) => r.idempotency_key)).toEqual([`subagent-finished:${CHILD}:msg_done`]);
  });

  test('a stop by a person mid-turn reports stopped once; the parent stopping it, or an idle child, sends nothing', async () => {
    await insertSession(CHILD, { parent: PARENT, metadata: background });
    // Idle: nothing to report.
    expect(await stoppedSubagentNotice(CHILD, null)).toBeNull();
    // A prompt on its way to the child: the child is working.
    await enqueueContinueSessionCommand({
      source: 'ui', projectId: PROJECT_ID, accountId: ACCOUNT_ID, sessionId: CHILD, actorUserId: AUTHOR,
      text: 'go on', clientMessageId: 'q_stop', idempotencyKey: `prompt:${CHILD}:q_stop`, placement: 'composer',
    });
    expect(await stoppedSubagentNotice(CHILD, PARENT)).toBeNull();
    const send = await stoppedSubagentNotice(CHILD, null);
    expect(await send!()).toBe(true);
    expect(await (await stoppedSubagentNotice(CHILD, null))!()).toBe(false);
    const rows = await parentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.text).toContain('status: stopped\n');
    expect(rows[0]!.payload.text).toContain('<task_error>\nA person stopped it before it finished.\n</task_error>');
  });

  test('a teammate always tells its lead, without notify_parent, and the notice names the tasks it still owns', async () => {
    await insertSession(CHILD, { parent: PARENT, metadata: { team_lead: PARENT, spawned_by_session: PARENT, agent_handle: 'builder' } });
    await db.execute(sql`
      INSERT INTO kortix.session_tasks (project_id, lead_session_id, seq, subject, status, owner_handle, owner_session_id)
      VALUES (${PROJECT_ID}::uuid, ${PARENT}, 1, 'Write the parser', 'in_progress', 'builder', ${CHILD}),
             (${PROJECT_ID}::uuid, ${PARENT}, 2, 'Ship it', 'completed', 'builder', ${CHILD})`);
    expect(await notifyParentOfSubagentTurn({ sessionId: CHILD, status: 'idle', turnMessageId: 'msg_team' })).toBe(true);
    const [row] = await parentRows();
    const text = row!.payload.text as string;
    expect(text).toStartWith('Your teammate builder finished its turn and is idle.');
    expect(text).toContain('Tasks builder still owns: #1 Write the parser (in progress).');
    expect(text).not.toContain('Ship it');
    // A team_lead the lead did not create (no spawned_by_session) is no teammate.
    const forged = crypto.randomUUID();
    await insertSession(forged, { parent: PARENT, metadata: { team_lead: PARENT } });
    expect(await notifyParentOfSubagentTurn({ sessionId: forged, status: 'idle', turnMessageId: 'm' })).toBe(false);
    await db.execute(sql`DELETE FROM kortix.session_tasks WHERE lead_session_id = ${PARENT}`);
  });

  test('a child that never started reports failed, once', async () => {
    await insertSession(CHILD, { parent: PARENT, metadata: background, status: 'failed' });
    expect(await notifyParentOfFailedStart(CHILD, 'Sandbox provisioning failed: capacity')).toBe(true);
    expect(await notifyParentOfFailedStart(CHILD, 'Sandbox provisioning failed: capacity')).toBe(false);
    const rows = await parentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.text).toContain('status: failed\n');
    expect(rows[0]!.payload.text).toContain('<task_error>\nSandbox provisioning failed: capacity\n</task_error>');
  });

  test('a turn the reaper settled without its box tells the parent, once per lost turn', async () => {
    await insertSession(CHILD, { parent: PARENT, metadata: background });
    transcript = [msg('user', 'go')];
    // The reaper's hook (sandbox-turn-lifecycle.ts clearSandboxTurn) reaches the registered relay.
    notifyTurnLost(CHILD, 'turn-lost-1');
    let rows: Awaited<ReturnType<typeof parentRows>> = [];
    for (let i = 0; i < 100 && rows.length === 0; i += 1) {
      rows = await parentRows();
      if (rows.length === 0) await Bun.sleep(20);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.text).toContain('status: error\n');
    expect(rows[0]!.payload.text).toContain('Its computer stopped before it finished.');
    // The same lost turn reported again writes nothing.
    expect(await notifyParentOfLostTurn(CHILD, 'turn-lost-1')).toBe(false);
    expect(await parentRows()).toHaveLength(1);
  });
});
