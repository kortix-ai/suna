import { describe, expect, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from './store';
import {
  MAX_PROMPT_REDELIVERIES,
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

// Matching a real row by any of its ids, the attempt budget, the cap and the
// stop-paused hold are proven on real rows in
// __tests__/integration-prompt-inbox.test.ts.
describe('requeueAbandonedPrompt', () => {
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

  // A delivery record only proves the ACCEPTANCE write never landed. The end
  // reason decides: a turn that COMPLETED or FAILED ran, and giving its prompt
  // back would run the user's message a second time. Only the three never-ran
  // reasons redeliver.
  test.each([
    ['abandoned', 'requeued'],
    ['runtime_gone', 'requeued'],
    ['unknown', 'requeued'],
    ['completed', 'ran'],
    ['failed', 'ran'],
  ] as const)('a turn that ended %s answers %s', async (endReason, outcome) => {
    const { deps, requeued, deadLettered } = harness(
      succeededRow({ text: 'hi', wireMessageId: 'msg_a' }),
    );

    expect(
      await requeueAbandonedPrompt(
        { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason },
        deps,
      ),
    ).toBe(outcome);
    expect(requeued).toHaveLength(outcome === 'requeued' ? 1 : 0);
    expect(deadLettered).toEqual([]);
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

  test('a plain FORWARDED prompt comes back DUE — nothing asked for it to wait', async () => {
    // Same shape, no stop: the delivery was abandoned by the runtime rather
    // than by the user, so the repair is a normal redelivery.
    const { deps, requeued } = harness(
      succeededRow(
        { text: 'hi', wireMessageId: 'msg_a' },
        { result: { status: 'forwarded', forwarded_message_id: 'msg_a' } },
      ),
    );

    expect(
      await requeueAbandonedPrompt(
        { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'abandoned' },
        deps,
      ),
    ).toBe('requeued');
    expect(requeued[0].held).toBeUndefined();
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
