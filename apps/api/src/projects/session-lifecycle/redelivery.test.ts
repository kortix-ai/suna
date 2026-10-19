import { describe, expect, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from './store';
import type { PromptTurnRecord } from '../session-turn-ledger';
import type { PlacementTipMessage } from './forwarded-placement';
import {
  MAX_PROMPT_REDELIVERIES,
  type RedeliveryDeps,
  findInterruptedTurn,
  interruptedTurnContinuationParts,
  interruptedTurnContinuationText,
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
    resumable: boolean;
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
        resumable: input.resumable,
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

describe('requeueAbandonedPrompt — the continuation mark (KRTX-1732)', () => {
  test('a requeue that proved a runtime loss marks the row; every other requeue clears it', async () => {
    const proven = harness(succeededRow({ text: 'hi', wireMessageId: 'msg_a' }));
    await requeueAbandonedPrompt(
      { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'runtime_gone', resumable: true },
      proven.deps,
    );
    expect(proven.requeued[0].resumable).toBe(true);

    const unproven = harness(succeededRow({ text: 'hi', wireMessageId: 'msg_a' }));
    await requeueAbandonedPrompt(
      { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'runtime_gone' },
      unproven.deps,
    );
    expect(unproven.requeued[0].resumable).toBe(false);
  });

  test('a Stop-paused row is never marked: a person stopped that turn', async () => {
    const { deps, requeued } = harness(
      succeededRow(
        { text: 'hi', wireMessageId: 'msg_a' },
        { result: { status: 'forwarded', stop_paused: true, held: true } },
      ),
    );
    await requeueAbandonedPrompt(
      { sessionId: 'sess-1', wireMessageId: 'msg_a', turnToken: 't', endReason: 'runtime_gone', resumable: true },
      deps,
    );
    expect(requeued[0]).toMatchObject({ held: true, resumable: false });
  });
});

describe('findInterruptedTurn', () => {
  const PROMPT = 'msg_prompt';
  const ENDED_AT = new Date('2026-10-14T12:03:20.000Z');
  const ledger = (patch: Partial<PromptTurnRecord> = {}) => async (): Promise<PromptTurnRecord> => ({
    turnToken: 'tok-1',
    messageId: PROMPT,
    state: 'ended',
    endReason: 'runtime_gone',
    endError: { name: 'SandboxStoppedMidTurn', message: 'The sandbox stopped unexpectedly while this turn was running.' },
    endedAt: ENDED_AT,
    ...patch,
  });
  const tip = (...rest: PlacementTipMessage[]): PlacementTipMessage[] => [
    { id: PROMPT, role: 'user' },
    ...rest,
  ];
  const openReply: PlacementTipMessage = { id: 'msg_reply', role: 'assistant', parentID: PROMPT, completed: null };

  test('a runtime_gone turn whose newest reply is still open is interrupted', async () => {
    const steps = tip({ id: 'msg_step1', role: 'assistant', parentID: PROMPT, completed: 1 }, openReply);
    expect(await findInterruptedTurn('sess-1', [PROMPT], steps, ledger())).toEqual({
      turnToken: 'tok-1',
      endedAt: ENDED_AT,
      cause: 'The sandbox stopped unexpectedly while this turn was running.',
    });
  });

  test('a turn whose runtime died before any reply is interrupted (a continuation that never ran)', async () => {
    expect(await findInterruptedTurn('sess-1', ['msg_old', PROMPT], tip(), ledger())).not.toBeNull();
  });

  test.each([
    ['the newest reply completed', ledger(), tip({ ...openReply, completed: 2 })],
    ['the turn completed', ledger({ endReason: 'completed' }), tip(openReply)],
    ['the turn is still open', ledger({ state: 'active', endReason: null }), tip(openReply)],
    ['a person stopped it', ledger({ endError: { name: 'UserStop', message: null } }), tip(openReply)],
    ['a queued prompt interrupted it', ledger({ endError: { name: 'QueueInterrupt', message: null } }), tip(openReply)],
    ['the transcript lost its message', ledger(), [openReply]],
    ['a later delivery of the prompt landed', ledger(), tip(openReply, { id: 'msg_cont', role: 'user' })],
  ])('no continuation when %s', async (_label, readTurn, messages) => {
    expect(await findInterruptedTurn('sess-1', [PROMPT, 'msg_cont'], messages, readTurn)).toBeNull();
  });

  describe('a turn that compacted before the stop (OpenCode auto compaction)', () => {
    const step = { id: 'msg_step1', role: 'assistant', parentID: PROMPT, completed: 1 };
    const marker: PlacementTipMessage = { id: 'msg_compact', role: 'user', autoCompaction: true };
    const summary: PlacementTipMessage = { id: 'msg_summary', role: 'assistant', parentID: 'msg_compact', completed: 2 };
    // The synthetic "continue", or a replay of the prompt: the same position.
    const resumed: PlacementTipMessage = { id: 'msg_continue', role: 'user' };
    const stepAfter = (completed: number | null): PlacementTipMessage =>
      ({ id: 'msg_step2', role: 'assistant', parentID: 'msg_continue', completed });

    test('the step after the compaction is the reply: open is interrupted', async () => {
      const steps = tip(step, marker, summary, resumed, stepAfter(null));
      expect(await findInterruptedTurn('sess-1', [PROMPT], steps, ledger())).not.toBeNull();
    });

    test('a box that died while it summarized is interrupted', async () => {
      const steps = tip(step, marker, { ...summary, completed: null });
      expect(await findInterruptedTurn('sess-1', [PROMPT], steps, ledger())).not.toBeNull();
    });

    test('a completed step after the compaction is no continuation', async () => {
      const steps = tip(step, marker, summary, resumed, stepAfter(3));
      expect(await findInterruptedTurn('sess-1', [PROMPT], steps, ledger())).toBeNull();
    });

    test('a manual compaction is a new turn, so its reply is not this turn\'s', async () => {
      const manual = { ...marker, autoCompaction: undefined };
      const steps = tip(step, manual, { ...summary, completed: null });
      expect(await findInterruptedTurn('sess-1', [PROMPT], steps, ledger())).toBeNull();
    });
  });

  test('a later prompt ends the turn: its reply is not this turn\'s', async () => {
    const later: PlacementTipMessage[] = [
      { id: 'msg_next', role: 'user' },
      { id: 'msg_next_reply', role: 'assistant', parentID: 'msg_next', completed: 5 },
    ];
    expect(await findInterruptedTurn('sess-1', [PROMPT], tip(openReply, ...later), ledger())).not.toBeNull();
  });

  test('no ledger turn at all is no continuation', async () => {
    expect(await findInterruptedTurn('sess-1', [PROMPT], tip(openReply), async () => null)).toBeNull();
  });

  test('the continuation names the time and cause, and never repeats the prompt', () => {
    expect(
      interruptedTurnContinuationText({ endedAt: ENDED_AT, cause: 'The sandbox stopped unexpectedly while this turn was running.' }),
    ).toBe(
      '[auto-recovery] The previous turn was interrupted at 2026-10-14 12:03 UTC. ' +
        'The sandbox stopped unexpectedly while this turn was running. ' +
        'Continue from where you left off. Do not repeat steps that already completed.',
    );
    expect(interruptedTurnContinuationText({ endedAt: null, cause: null })).toBe(
      '[auto-recovery] The previous turn was interrupted. The runtime that ran it stopped. ' +
        'Continue from where you left off. Do not repeat steps that already completed.',
    );
  });

  test('the continuation goes on the wire marked synthetic — harness context, not a user prompt (KRTX-2597)', () => {
    expect(interruptedTurnContinuationParts({ endedAt: ENDED_AT, cause: 'The sandbox stopped unexpectedly while this turn was running.' })).toEqual([
      {
        type: 'text',
        text: '[auto-recovery] The previous turn was interrupted at 2026-10-14 12:03 UTC. ' +
          'The sandbox stopped unexpectedly while this turn was running. ' +
          'Continue from where you left off. Do not repeat steps that already completed.',
        synthetic: true,
      },
    ]);
  });
});
