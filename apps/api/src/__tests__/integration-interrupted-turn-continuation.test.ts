/**
 * Integration test (real local PostgreSQL): a turn the runtime loss cut short
 * gets exactly ONE continuation, and nothing else does (KRTX-1732).
 *
 * Before this, the reaper requeued the interrupted prompt and the drain then
 * dropped it as `already_answered`: the interrupted assistant reply is
 * parented on the prompt, and "answered" ignored whether it ever completed.
 * The member had to type "go on"; an unattended worker never resumed while
 * the ledger said "Kortix restarted it and resumed this turn".
 *
 * Real: the stop writer (`applyStoppedState`), the requeue, the inbox hold and
 * release, the claim, admission, the remint, the forward, the ledger read and
 * the ledger `resumed` write. Stubbed: the box. `sandboxOpencodeEndpoint`
 * returns a fixed address, `fetch` serves the transcript, `continueSession`
 * records the POST instead of waking a sandbox, and the drain kick is a no-op.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import * as realOpencodeMapping from '../projects/opencode-mapping';
import * as realContinueSession from '../projects/session-lifecycle/continue-session';
import * as realDrain from '../projects/session-lifecycle/drain';
import { mintWireMessageId } from '../projects/wire-message-id';

const BOX_URL = 'http://interrupted-turn-box.test';
const BOX_ORIGIN = new URL(BOX_URL).origin;
const ROOT = 'ses_interrupted_root';
const NOW_MS = Date.now();
const wire = (agoMs: number) => mintWireMessageId({ nowMs: NOW_MS - agoMs, random: () => 0.5 }).id;

/** What the box holds. Each test writes it; a POST appends the user message. */
let transcript: Array<Record<string, unknown>> = [];
/** Every prompt POST the drain made, in order. */
let posts: Array<{ text: string; wireMessageId?: string }> = [];
/** Answers for the next POSTs; empty = delivered. */
let postPlan: Array<'delivered' | 'pending'> = [];
/** The box holds a staged rewind (`GET /session/:id` answers `revert`). */
let stagedRevert = false;

mock.module('../projects/opencode-mapping', () => ({
  ...realOpencodeMapping,
  sandboxOpencodeEndpoint: async () => ({ url: BOX_URL, headers: {} }),
}));
mock.module('../projects/session-lifecycle/continue-session', () => ({
  ...realContinueSession,
  continueSession: async (command: { text: string; wireMessageId?: string }) => {
    posts.push({ text: command.text, wireMessageId: command.wireMessageId });
    // The POST lands either way: a `pending` answer is the response the API
    // lost, not a message the box never stored.
    if (command.wireMessageId) {
      transcript.push({ info: { id: command.wireMessageId, role: 'user', sessionID: ROOT }, parts: [] });
    }
    return postPlan.shift() ?? 'delivered';
  },
}));
mock.module('../projects/session-lifecycle/drain', () => ({
  ...realDrain,
  drainSessionLifecycleQueue: async () => undefined,
}));

const { db } = await import('../shared/db');
const { applyStoppedState } = await import('../projects/reaping/sandbox-state-sync');
const { executeQueuedContinue } = await import('../projects/session-lifecycle/queued-continue');
const { holdInboxPrompts, listInboxPrompts, retryInboxPrompt } = await import(
  '../projects/session-lifecycle/inbox-rows'
);
const { claimDueLifecycleCommands, enqueueContinueSessionCommand, markCommandForwarded } =
  await import('../projects/session-lifecycle/store');
const { markTurnStopRequested } = await import('../projects/session-turn-ledger');
const { recoverTurnsAfterRuntimeRestart } = await import(
  '../projects/session-lifecycle/runtime-restart-recovery'
);

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const AUTHOR = crypto.randomUUID();
let SESSION_ID = '';
let SANDBOX_ID = '';
let TOKEN = '';

type Row = Record<string, any>;
const rowsOf = (result: unknown): Row[] => ((result as { rows?: Row[] }).rows ?? result) as Row[];

async function commands(): Promise<Row[]> {
  return rowsOf(await db.execute(sql`
    SELECT command_id, idempotency_key, source, status, actor_user_id, payload, result, available_at
      FROM kortix.session_lifecycle_commands
     WHERE session_id = ${SESSION_ID}
     ORDER BY created_at`));
}

async function command(commandId: string): Promise<Row> {
  return (await commands()).find((row) => row.command_id === commandId)!;
}

async function turnEndError(token = TOKEN): Promise<{ name: string | null; message?: string | null } | null> {
  const [row] = rowsOf(await db.execute(sql`
    SELECT end_error FROM kortix.session_turns WHERE turn_token = ${token}`));
  return row?.end_error ?? null;
}

/** One `activeTurns` entry: the box runs `token` on `messageId`. */
const openTurn = (token: string, messageId: string, state: 'active' | 'delivering' = 'active') => ({
  token,
  state,
  opencodeSessionId: ROOT,
  runtimeSessionId: ROOT,
  messageId,
  startedAtMs: NOW_MS - 9 * 60_000,
});

/** The box runs again, with `turns` open: a second observer, or a turn after a wake. */
async function reopenBox(turns: Record<string, ReturnType<typeof openTurn>>) {
  await db.execute(sql`
    UPDATE kortix.session_sandboxes
       SET status = 'active', metadata = metadata || ${JSON.stringify({ activeTurns: turns })}::jsonb
     WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
  await db.execute(sql`UPDATE kortix.project_sessions SET status = 'running' WHERE session_id = ${SESSION_ID}`);
}

/** The box's past unattended recoveries (`autoRecovery.attempts`, epoch ms). */
async function setRecoveryAttempts(attempts: number[]) {
  await db.execute(sql`
    UPDATE kortix.session_sandboxes
       SET metadata = metadata || ${JSON.stringify({ autoRecovery: { attempts } })}::jsonb
     WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
}

/** A session whose box runs one open turn on `messageId`. */
async function seedSession(input: { origin: 'user' | 'trigger'; messageId: string; turnState?: 'active' | 'delivering' }) {
  SESSION_ID = crypto.randomUUID();
  SANDBOX_ID = crypto.randomUUID();
  TOKEN = `tok-${SANDBOX_ID}`;
  await db.execute(sql`
    INSERT INTO kortix.project_sessions
      (session_id, account_id, project_id, branch_name, status, opencode_session_id, created_by, origin)
    VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${SESSION_ID}`}, 'running',
            ${ROOT}, ${AUTHOR}::uuid, ${input.origin})`);
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, external_id, status, metadata)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            ${`ext-${SANDBOX_ID}`}, 'active',
            ${JSON.stringify({ activeTurns: { [TOKEN]: openTurn(TOKEN, input.messageId, input.turnState) } })}::jsonb)`);
  await db.execute(sql`
    INSERT INTO kortix.session_turns
      (turn_token, session_id, sandbox_id, project_id, account_id, opencode_session_id, message_id, state)
    VALUES (${TOKEN}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid,
            ${ROOT}, ${input.messageId}, ${input.turnState ?? 'active'})`);
}

/** The member's prompt, already forwarded to the box under `wireMessageId`. */
async function forwardedPrompt(wireMessageId: string): Promise<string> {
  const { row } = await enqueueContinueSessionCommand({
    source: 'ui',
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    actorUserId: AUTHOR,
    text: 'refactor the billing module',
    idempotencyKey: `prompt:${SESSION_ID}:q_refactor`,
    clientMessageId: 'q_refactor',
    wireMessageId,
    parts: [{ type: 'text', text: 'refactor the billing module' }],
    bindTurnIdentity: true,
  });
  await db.execute(sql`
    UPDATE kortix.session_lifecycle_commands SET status = 'running', locked_by = 'it'
     WHERE command_id = ${row.commandId}::uuid`);
  await markCommandForwarded({ commandId: row.commandId, lockedBy: 'it' }, SESSION_ID, wireMessageId);
  return row.commandId;
}

/** The provider stopped the box mid-turn (`provider_reconcile`). */
const providerStop = () =>
  applyStoppedState({
    sandboxId: SANDBOX_ID,
    sessionId: SESSION_ID,
    externalId: `ext-${SANDBOX_ID}`,
    stopReason: 'provider_reconcile',
  });

/** The runtime is up again: the wake's own recovery step (`resume-stopped-sandbox.ts`). */
const wake = () =>
  recoverTurnsAfterRuntimeRestart({ sandboxId: SANDBOX_ID, sessionId: SESSION_ID, externalId: `ext-${SANDBOX_ID}`, hold: false });

/** Claim `commandId` the way the drain does and run it once. */
async function drainOnce(commandId: string) {
  const [row] = await claimDueLifecycleCommands({
    workerId: 'interrupted-turn-it',
    limit: 1,
    idempotencyKey: (await command(commandId)).idempotency_key,
    now: new Date(Date.now() + 3_600_000),
  });
  if (!row) return 'not_claimed' as const;
  return executeQueuedContinue(row);
}

/** The box after a restart: the prompt, then the reply the stop cut off. */
function interruptedTranscript(prompt: string, opts: { completed?: boolean } = {}) {
  transcript = [
    { info: { id: prompt, role: 'user', sessionID: ROOT, time: { created: NOW_MS - 9 * 60_000 } }, parts: [] },
    {
      info: {
        id: wire(8 * 60_000),
        role: 'assistant',
        sessionID: ROOT,
        parentID: prompt,
        time: opts.completed
          ? { created: NOW_MS - 8 * 60_000, completed: NOW_MS - 7 * 60_000 }
          : { created: NOW_MS - 8 * 60_000 },
      },
      parts: [],
    },
  ];
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'interrupted-turn-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'interrupted-turn-it', 'https://example.invalid/r.git')`);
  (globalThis as { fetch: unknown }).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    let origin: string | null;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = null;
    }
    if (origin !== BOX_ORIGIN) return ORIGINAL_FETCH(input, init);
    if (stagedRevert && new URL(url).pathname === `/session/${ROOT}`) {
      return Response.json({ id: ROOT, revert: { messageID: 'msg_rewound' } });
    }
    return Response.json(transcript);
  };
});

beforeEach(() => {
  transcript = [];
  posts = [];
  postPlan = [];
  stagedRevert = false;
});

// No row cleanup: the db-suites lane drops this file's database after the run,
// and the identity guard refuses to delete a sandbox row with an external id.
afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('the drain continues a turn the runtime loss cut short', () => {
  test('an interrupted turn gets one continuation, not the original prompt and not a drop', async () => {
    const prompt = wire(9 * 60_000);
    await seedSession({ origin: 'user', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    await providerStop();

    // Attended: the prompt comes back HELD, marked as a turn that may be continued.
    const held = await command(commandId);
    expect(held.status).toBe('queued');
    expect(held.result.held).toBe(true);
    expect(held.payload.resumeIfInterrupted).toBe(true);
    expect(await drainOnce(commandId)).toBe('not_claimed');
    // The ledger names the stop, and does not claim a resume nobody delivered yet.
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurn');

    // The member presses Send now on the held row.
    interruptedTranscript(prompt);
    await retryInboxPrompt(SESSION_ID, commandId, { userId: AUTHOR });
    expect(await drainOnce(commandId)).toBe('succeeded');

    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('interrupted');
    expect(posts[0].text).toContain('Continue from where you left off');
    expect(posts[0].text).not.toContain('refactor the billing module');
    expect(posts[0].wireMessageId).not.toBe(prompt);
    const after = await command(commandId);
    expect(after.result).toMatchObject({ status: 'forwarded', forwarded_message_id: posts[0].wireMessageId });
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurnRecovering');
  });

  test('a turn whose reply completed is never re-sent and never continued', async () => {
    const prompt = wire(9 * 60_000);
    await seedSession({ origin: 'user', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    await providerStop();

    interruptedTranscript(prompt, { completed: true });
    await retryInboxPrompt(SESSION_ID, commandId, { userId: AUTHOR });
    expect(await drainOnce(commandId)).toBe('succeeded');

    expect(posts).toEqual([]);
    expect((await command(commandId)).result).toEqual({ status: 'skipped', reason: 'already_answered' });
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurn');
  });

  test('a turn the member stopped is not continued, even when the box died before the abort landed', async () => {
    const prompt = wire(9 * 60_000);
    await seedSession({ origin: 'user', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    await markTurnStopRequested(SESSION_ID, 'UserStop');
    await providerStop();

    interruptedTranscript(prompt);
    await retryInboxPrompt(SESSION_ID, commandId, { userId: AUTHOR });
    expect(await drainOnce(commandId)).toBe('succeeded');

    expect(posts).toEqual([]);
    expect((await command(commandId)).result).toEqual({ status: 'skipped', reason: 'already_answered' });
    expect((await turnEndError())?.name).toBe('UserStop');
  });

  test('a manual session stop leaves its prompt held, and a later release does not continue it', async () => {
    const prompt = wire(9 * 60_000);
    // A delivering turn: the only kind a stop Kortix or a person chose gives back.
    await seedSession({ origin: 'user', messageId: prompt, turnState: 'delivering' });
    const commandId = await forwardedPrompt(prompt);
    await applyStoppedState({
      sandboxId: SANDBOX_ID,
      sessionId: SESSION_ID,
      externalId: `ext-${SANDBOX_ID}`,
      stopReason: 'manual',
    });

    const held = await command(commandId);
    expect(held.result.held).toBe(true);
    expect(held.payload.resumeIfInterrupted).toBe(false);
    // A wake is not consent to send a prompt someone's stop held.
    await wake();
    expect(await drainOnce(commandId)).toBe('not_claimed');

    interruptedTranscript(prompt);
    await retryInboxPrompt(SESSION_ID, commandId, { userId: AUTHOR });
    expect(await drainOnce(commandId)).toBe('succeeded');
    expect(posts).toEqual([]);
    expect((await command(commandId)).result).toEqual({ status: 'skipped', reason: 'already_answered' });
  });

  test('a stop-paused prompt stays held and is not marked for a continuation', async () => {
    const prompt = wire(9 * 60_000);
    await seedSession({ origin: 'trigger', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    // The member pressed Stop while the prompt was on the wire.
    await holdInboxPrompts(SESSION_ID, true);
    await providerStop();

    const held = await command(commandId);
    expect(held.status).toBe('queued');
    expect(held.result.held).toBe(true);
    expect(held.payload.resumeIfInterrupted).toBe(false);
    await wake();
    expect(await drainOnce(commandId)).toBe('not_claimed');
    // A person stopped it: no synthetic continuation beside the held prompt.
    expect(await commands()).toHaveLength(1);
  });

  test('the wake releases the held prompt: reopening the session starts the continuation', async () => {
    const prompt = wire(9 * 60_000);
    await seedSession({ origin: 'user', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    await providerStop();
    expect(await drainOnce(commandId)).toBe('not_claimed');

    interruptedTranscript(prompt);
    await wake();
    expect((await command(commandId)).result.held).toBeUndefined();
    expect(await drainOnce(commandId)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('Continue from where you left off');
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurnRecovering');
  });

  test('a turn that compacted before the stop is continued: the reply after the compaction is open', async () => {
    const prompt = wire(9 * 60_000);
    const marker = wire(7 * 60_000);
    const resumed = wire(6 * 60_000);
    await seedSession({ origin: 'user', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    await providerStop();

    // OpenCode's automatic compaction: a marker, its summary, a synthetic
    // "continue", and the later steps parented on that continue.
    transcript = [
      { info: { id: prompt, role: 'user', sessionID: ROOT }, parts: [] },
      { info: { id: wire(8 * 60_000), role: 'assistant', sessionID: ROOT, parentID: prompt, time: { created: 1, completed: 2 } }, parts: [] },
      { info: { id: marker, role: 'user', sessionID: ROOT }, parts: [{ id: 'prt_compact', type: 'compaction', auto: true }] },
      { info: { id: wire(390_000), role: 'assistant', sessionID: ROOT, parentID: marker, summary: true, time: { created: 3, completed: 4 } }, parts: [] },
      { info: { id: resumed, role: 'user', sessionID: ROOT }, parts: [{ id: 'prt_continue', type: 'text', text: 'Continue if you have next steps.', synthetic: true }] },
      { info: { id: wire(5 * 60_000), role: 'assistant', sessionID: ROOT, parentID: resumed, time: { created: 5 } }, parts: [] },
    ];
    await retryInboxPrompt(SESSION_ID, commandId, { userId: AUTHOR });
    expect(await drainOnce(commandId)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('Continue from where you left off');
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurnRecovering');
  });

  test('a turn a runtime restart cut short says the runtime restarted, once its continuation lands', async () => {
    const prompt = wire(9 * 60_000);
    await seedSession({ origin: 'user', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    // A config swap retired the runtime under the turn; the sandbox kept running.
    await wake();
    expect(await turnEndError()).toBeNull();

    interruptedTranscript(prompt);
    expect(await drainOnce(commandId)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect(await turnEndError()).toEqual({
      name: 'RuntimeRestartedMidTurnRecovering',
      message: 'The runtime restarted during this turn. Kortix resumed it.',
    });
  });

  test('a retry after a continuation landed unacknowledged sends no second one', async () => {
    const prompt = wire(9 * 60_000);
    await seedSession({ origin: 'user', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    await providerStop();

    interruptedTranscript(prompt);
    await retryInboxPrompt(SESSION_ID, commandId, { userId: AUTHOR });
    // The continuation reaches the box, but its answer is lost: the row retries.
    postPlan = ['pending'];
    expect(await drainOnce(commandId)).toBe('queued');
    expect(posts).toHaveLength(1);

    // The retry reads the transcript, finds the continuation, and sends nothing.
    expect(await drainOnce(commandId)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurn');
  });
});

describe('the reaper leaves no interrupted turn without its one continuation', () => {
  test('an unattended worker: the released prompt is continued, and the ledger says resumed only after delivery', async () => {
    const prompt = wire(9 * 60_000);
    await seedSession({ origin: 'trigger', messageId: prompt });
    const commandId = await forwardedPrompt(prompt);
    await providerStop();

    const due = await command(commandId);
    expect(due.status).toBe('queued');
    expect(due.result.held).toBeUndefined();
    expect(due.payload.resumeIfInterrupted).toBe(true);
    // The released row carries the turn: no synthetic prompt beside it.
    expect(await commands()).toHaveLength(1);
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurn');

    interruptedTranscript(prompt);
    expect(await drainOnce(commandId)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('Continue from where you left off');
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurnRecovering');
  });

  test('an unattended first turn (no inbox row) gets one keyed continuation, even when two passes see it', async () => {
    // The first turn came from `create_session`: no `continue_session` row exists.
    await seedSession({ origin: 'trigger', messageId: wire(9 * 60_000) });
    await providerStop();
    // A second observer (the webhook racing the reaper) sees the same turn.
    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET status = 'active',
             metadata = (SELECT metadata FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid)
                        || ${JSON.stringify({
                          activeTurns: {
                            [TOKEN]: { token: TOKEN, state: 'active', opencodeSessionId: ROOT, messageId: 'msg_none', startedAtMs: NOW_MS },
                          },
                        })}::jsonb
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
    await db.execute(sql`UPDATE kortix.project_sessions SET status = 'running' WHERE session_id = ${SESSION_ID}`);
    await providerStop();

    const rows = await commands();
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe(`prompt:${SESSION_ID}:resume_${TOKEN}`);
    expect(rows[0].source).toBe('system:auto-recovery');
    expect(rows[0].payload.resumesTurn).toBe(TOKEN);
    expect(rows[0].payload.text).toContain('Continue from where you left off');
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurn');

    expect(await drainOnce(rows[0].command_id)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurnRecovering');
  });

  test('an attended first turn gets one HELD continuation its member can send', async () => {
    await seedSession({ origin: 'user', messageId: wire(9 * 60_000) });
    await providerStop();

    const rows = await commands();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.actor_user_id).toBe(AUTHOR);
    expect(row.result).toEqual({ held: true });
    expect(row.payload).toMatchObject({
      clientMessageId: `resume_${TOKEN}`,
      bindTurnIdentity: true,
      remintOnDelivery: true,
      resumesTurn: TOKEN,
    });
    // Held: the next drain tick does not wake the box the provider just stopped.
    expect(await drainOnce(row.command_id)).toBe('not_claimed');
    // Visible in the member's queue, where Send now releases it.
    expect((await listInboxPrompts(SESSION_ID, 50)).map((prompt) => prompt.commandId)).toContain(row.command_id);

    await retryInboxPrompt(SESSION_ID, row.command_id, { userId: AUTHOR });
    expect(await drainOnce(row.command_id)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('interrupted');
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurnRecovering');
  });

  test('the wake releases an attended first turn\'s held continuation', async () => {
    await seedSession({ origin: 'user', messageId: wire(9 * 60_000) });
    await providerStop();
    const [row] = await commands();
    expect(await drainOnce(row.command_id)).toBe('not_claimed');

    await wake();
    expect(await drainOnce(row.command_id)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurnRecovering');
  });

  test.each(['trigger', 'user'] as const)(
    'a first turn a person stopped gets no continuation (%s session)',
    async (origin) => {
      await seedSession({ origin, messageId: wire(9 * 60_000) });
      // The box died and the member pressed Stop: the stamp landed on the open
      // ledger row, and the abort never reached the dead box.
      await markTurnStopRequested(SESSION_ID, 'UserStop');
      await providerStop();

      expect((await turnEndError())?.name).toBe('UserStop');
      expect(await commands()).toEqual([]);
    },
  );

  test('an observer whose unattended claim is bounded writes nothing; the claiming one writes the due continuation', async () => {
    await seedSession({ origin: 'trigger', messageId: wire(9 * 60_000) });
    const turns = { [TOKEN]: openTurn(TOKEN, 'msg_none') };
    // Inside the 30 s gap: this observer's claim answers bounded.
    await setRecoveryAttempts([Date.now() - 5_000]);
    await providerStop();
    expect(await commands()).toEqual([]);

    await reopenBox(turns);
    await setRecoveryAttempts([Date.now() - 120_000]);
    await providerStop();
    const rows = await commands();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBeNull();
    expect(rows[0].payload.clientMessageId).toBeUndefined();
    expect(rows[0].result?.held).toBeUndefined();
  });

  test('a continuation a staged rewind drops is not marked resumed', async () => {
    await seedSession({ origin: 'trigger', messageId: wire(9 * 60_000) });
    await providerStop();
    const [row] = await commands();

    stagedRevert = true;
    expect(await drainOnce(row.command_id)).toBe('succeeded');
    expect(posts).toEqual([]);
    expect((await command(row.command_id)).result).toEqual({ status: 'skipped', reason: 'staged_revert' });
    expect((await turnEndError())?.name).toBe('SandboxStoppedMidTurn');
  });

  test('an unattended continuation is a tracked turn: a second stop continues it again', async () => {
    await seedSession({ origin: 'trigger', messageId: wire(9 * 60_000) });
    await providerStop();
    const [row] = await commands();
    expect(row.payload.wireMessageId).toEqual(expect.any(String));
    expect(row.payload.clientMessageId).toBeUndefined();
    expect(await drainOnce(row.command_id)).toBe('succeeded');
    expect(posts).toHaveLength(1);
    const continued = posts[0].wireMessageId!;
    expect(continued).toEqual(expect.any(String));

    // The continuation's turn runs, and the provider stops the box again.
    const second = `tok2-${SANDBOX_ID}`;
    await db.execute(sql`
      INSERT INTO kortix.session_turns
        (turn_token, session_id, sandbox_id, project_id, account_id, opencode_session_id, message_id, state)
      VALUES (${second}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid,
              ${ROOT}, ${continued}, 'active')`);
    await reopenBox({ [second]: openTurn(second, continued) });
    await setRecoveryAttempts([Date.now() - 120_000]);
    await providerStop();

    // The continuation row itself comes back, due; no second synthetic row.
    const rows = await commands();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('queued');
    expect(rows[0].payload).toMatchObject({ redeliveries: 1, resumeIfInterrupted: true });

    transcript.push({
      info: { id: mintWireMessageId({ nowMs: Date.now() + 1_000 }).id, role: 'assistant', sessionID: ROOT, parentID: continued, time: { created: 6 } },
      parts: [],
    });
    expect(await drainOnce(row.command_id)).toBe('succeeded');
    expect(posts).toHaveLength(2);
    expect(posts[1].text).toContain('Continue from where you left off');
    expect((await turnEndError(second))?.name).toBe('SandboxStoppedMidTurnRecovering');
  });
});
