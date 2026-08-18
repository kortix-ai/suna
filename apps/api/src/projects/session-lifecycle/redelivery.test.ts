import { describe, expect, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from './store';
import {
  MAX_PROMPT_REDELIVERIES,
  PROMPT_NEVER_RAN_END_REASONS,
  type RedeliveryDeps,
  requeueAbandonedPrompt,
} from './redelivery';

function succeededRow(
  payload: Record<string, unknown>,
  overrides: Partial<SessionLifecycleCommandRow> = {},
): SessionLifecycleCommandRow {
  return {
    commandId: 'cmd-1',
    commandType: 'continue_session',
    sessionId: 'sess-1',
    status: 'succeeded',
    attempts: 1,
    payload,
    result: {},
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    ...overrides,
  } as SessionLifecycleCommandRow;
}

function harness(row: SessionLifecycleCommandRow | null) {
  const requeued: Array<{
    commandId: string;
    redeliveries: number;
    lastError: string;
    held?: boolean;
  }> = [];
  const deadLettered: string[] = [];
  const deps: RedeliveryDeps = {
    findPromptByWireId: async () => row,
    requeue: async (input) => {
      requeued.push({
        commandId: input.commandId,
        redeliveries: input.redeliveries,
        lastError: input.lastError,
        held: input.held,
      });
    },
    deadLetter: async (input) => {
      deadLettered.push(input.commandId);
    },
  };
  return { deps, requeued, deadLettered };
}

describe('requeueAbandonedPrompt', () => {
  test('a proven-abandoned turn gives its prompt back to the inbox', async () => {
    const { deps, requeued } = harness(succeededRow({ text: 'hi', wireMessageId: 'msg_a' }));

    const outcome = await requeueAbandonedPrompt(
      {
        sessionId: 'sess-1',
        wireMessageId: 'msg_a',
        turnToken: 'turn-1',
        endReason: 'abandoned',
      },
      deps,
    );

    expect(outcome).toBe('requeued');
    expect(requeued).toEqual([
      { commandId: 'cmd-1', redeliveries: 1, lastError: 'redelivered after abandoned' },
    ]);
  });

  test('a turn with NO wire message id is never matched — it is not an inbox prompt', async () => {
    // Channel/trigger prompts and every browser prompt from before the inbox
    // carry no wire id. Requeueing by anything looser could resend a prompt
    // whose turn actually ran.
    const { deps, requeued } = harness(succeededRow({ text: 'hi' }));

    const outcome = await requeueAbandonedPrompt(
      { sessionId: 'sess-1', wireMessageId: null, turnToken: 'turn-1', endReason: 'abandoned' },
      deps,
    );

    expect(outcome).toBe('no_prompt');
    expect(requeued).toEqual([]);
  });

  test('no matching command is `no_prompt`, not an error', async () => {
    const { deps } = harness(null);
    expect(
      await requeueAbandonedPrompt(
        { sessionId: 'sess-1', wireMessageId: 'msg_x', turnToken: 't', endReason: 'runtime_gone' },
        deps,
      ),
    ).toBe('no_prompt');
  });

  test('a command that is not `succeeded` is already settled and left alone', async () => {
    // It is queued, running, or dead-lettered — something else owns it, and a
    // second requeue would double-deliver.
    const { deps, requeued } = harness(
      succeededRow({ text: 'hi', wireMessageId: 'msg_a' }, { status: 'queued' }),
    );

    const outcome = await requeueAbandonedPrompt(
      { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'abandoned' },
      deps,
    );

    expect(outcome).toBe('already_settled');
    expect(requeued).toEqual([]);
  });

  test('the redelivery counter advances from the payload, and matches the RE-MINTED id too', async () => {
    const { deps, requeued } = harness(
      succeededRow({
        text: 'hi',
        wireMessageId: 'msg_a',
        redeliveredMessageId: 'msg_b',
        redeliveries: 1,
      }),
    );

    // The reaper sees the id the LAST delivery actually used, not the original.
    const outcome = await requeueAbandonedPrompt(
      { sessionId: 'sess-1', wireMessageId: 'msg_b', turnToken: 't', endReason: 'runtime_gone' },
      deps,
    );

    expect(outcome).toBe('requeued');
    expect(requeued[0].redeliveries).toBe(2);
  });

  test('exhausts at the cap instead of resending for ever', async () => {
    const { deps, requeued, deadLettered } = harness(
      succeededRow({
        text: 'hi',
        wireMessageId: 'msg_a',
        redeliveries: MAX_PROMPT_REDELIVERIES,
      }),
    );

    const outcome = await requeueAbandonedPrompt(
      { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'abandoned' },
      deps,
    );

    expect(outcome).toBe('exhausted');
    expect(requeued).toEqual([]);
    expect(deadLettered).toEqual(['cmd-1']);
  });

  test('a turn the daemon says COMPLETED is never redelivered — it RAN', async () => {
    // The delivery record only proves the ACCEPTANCE write never landed (the
    // documented `[turn-lifecycle] acceptance persistence failed` path). The
    // daemon reporting `completed` proves the turn itself ran to the end, so
    // giving the prompt back would run the user's message a second time.
    const { deps, requeued, deadLettered } = harness(
      succeededRow({ text: 'hi', wireMessageId: 'msg_a' }),
    );

    const outcome = await requeueAbandonedPrompt(
      { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'completed' },
      deps,
    );

    expect(outcome).toBe('ran');
    expect(requeued).toEqual([]);
    expect(deadLettered).toEqual([]);
  });

  test('a turn the daemon says FAILED is never redelivered either', async () => {
    // It ran and errored. The user sees the error; re-running it would spend a
    // second real LLM turn on a prompt that was answered.
    const { deps, requeued } = harness(succeededRow({ text: 'hi', wireMessageId: 'msg_a' }));

    expect(
      await requeueAbandonedPrompt(
        { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'failed' },
        deps,
      ),
    ).toBe('ran');
    expect(requeued).toEqual([]);
  });

  test('only the three "never ran" reasons may redeliver', async () => {
    expect([...PROMPT_NEVER_RAN_END_REASONS].sort()).toEqual([
      'abandoned',
      'runtime_gone',
      'unknown',
    ]);
  });

  test('a prompt given back by a PARKED box comes back HELD, not re-armed', async () => {
    // `applyStoppedState` is the caller. Requeueing due-now there would make
    // the very next drain tick wake the box that was just parked and bill the
    // account for the resumed compute — so the row comes back visible and
    // held, and the user's next send (or send-now) releases it.
    const { deps, requeued } = harness(succeededRow({ text: 'hi', wireMessageId: 'msg_a' }));

    const outcome = await requeueAbandonedPrompt(
      {
        sessionId: 'sess-1',
        wireMessageId: 'msg_a',
        turnToken: 't',
        endReason: 'runtime_gone',
        hold: true,
      },
      deps,
    );

    expect(outcome).toBe('requeued');
    expect(requeued[0].held).toBe(true);
  });

  test('the cap is 3 — the 3rd redelivery still goes out', async () => {
    expect(MAX_PROMPT_REDELIVERIES).toBe(3);
    const { deps, requeued } = harness(
      succeededRow({ text: 'hi', wireMessageId: 'msg_a', redeliveries: 2 }),
    );
    expect(
      await requeueAbandonedPrompt(
        { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'abandoned' },
        deps,
      ),
    ).toBe('requeued');
    expect(requeued[0].redeliveries).toBe(3);
  });
});
