import { describe, expect, test } from 'bun:test';

import { compactionTurnInfo } from './compaction-state';

type Msg = { info?: unknown; parts?: Array<{ type: string; text?: string }> };

function turn(assistantMessages: Msg[], userMessage?: Msg) {
  return {
    userMessage: userMessage
      ? { info: userMessage.info ?? {}, parts: userMessage.parts ?? [] }
      : undefined,
    assistantMessages: assistantMessages.map((m) => ({ info: m.info ?? {}, parts: m.parts ?? [] })),
  };
}

describe('compactionTurnInfo', () => {
  test('an ordinary turn is not a compaction', () => {
    expect(compactionTurnInfo(turn([{ parts: [{ type: 'text', text: 'hi' }] }]))).toEqual({
      isCompaction: false,
      hasContent: true,
      inFlight: false,
      error: null,
    });
  });

  test('summary flag alone, still open → a compaction in flight with no content yet', () => {
    expect(compactionTurnInfo(turn([{ info: { summary: true } }]))).toEqual({
      isCompaction: true,
      hasContent: false,
      inFlight: true,
      error: null,
    });
  });

  test('summary flag with streamed text, still open → in flight with content', () => {
    expect(
      compactionTurnInfo(
        turn([{ info: { summary: true }, parts: [{ type: 'text', text: 'The session so far…' }] }]),
      ),
    ).toEqual({ isCompaction: true, hasContent: true, inFlight: true, error: null });
  });

  test('completed summary is no longer in flight', () => {
    expect(
      compactionTurnInfo(
        turn([
          {
            info: { summary: true, time: { completed: 123 } },
            parts: [{ type: 'text', text: 'summary' }],
          },
        ]),
      ),
    ).toEqual({ isCompaction: true, hasContent: true, inFlight: false, error: null });
  });

  test('errored summary with no content is a FINISHED failed attempt, with its error surfaced', () => {
    const error = { name: 'UnknownError', data: { message: 'boom' } };
    expect(compactionTurnInfo(turn([{ info: { summary: true, error } }]))).toEqual({
      isCompaction: true,
      hasContent: false,
      inFlight: false,
      error,
    });
  });

  test('a compaction part marks a landed compaction — it only exists once it landed', () => {
    expect(compactionTurnInfo(turn([{ parts: [{ type: 'compaction' }] }]))).toEqual({
      isCompaction: true,
      hasContent: true,
      inFlight: false,
      error: null,
    });
  });

  test('whitespace-only text does not count as content', () => {
    expect(
      compactionTurnInfo(
        turn([
          { info: { summary: true, time: { completed: 1 } }, parts: [{ type: 'text', text: '  \n' }] },
        ]),
      ),
    ).toEqual({ isCompaction: true, hasContent: false, inFlight: false, error: null });
  });

  test('flags aggregate across multiple assistant messages', () => {
    expect(
      compactionTurnInfo(
        turn([
          { info: { summary: true, time: { completed: 1 } } },
          { parts: [{ type: 'text', text: 'summary' }] },
        ]),
      ),
    ).toEqual({ isCompaction: true, hasContent: true, inFlight: false, error: null });
  });

  // ── Synthetic turns ────────────────────────────────────────────────────
  // A summary message with no user prompt to attach to becomes the turn's
  // `userMessage` with EMPTY assistantMessages (groupMessagesIntoTurns).
  // Missing these rendered each failed attempt as an empty 0px turn that
  // content-visibility ballooned to a 600px blank block.

  test('synthetic turn: errored summary as userMessage is a failed compaction with its error', () => {
    const error = { name: 'UnknownError', data: { message: 'Cannot connect to API' } };
    expect(compactionTurnInfo(turn([], { info: { summary: true, error } }))).toEqual({
      isCompaction: true,
      hasContent: false,
      inFlight: false,
      error,
    });
  });

  test('synthetic turn: open summary as userMessage is in flight', () => {
    expect(compactionTurnInfo(turn([], { info: { summary: true } }))).toEqual({
      isCompaction: true,
      hasContent: false,
      inFlight: true,
      error: null,
    });
  });

  test("a REAL user prompt's text never counts — no summary flag, no compaction", () => {
    expect(
      compactionTurnInfo(
        turn([], { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello there' }] }),
      ),
    ).toEqual({ isCompaction: false, hasContent: false, inFlight: false, error: null });
  });

  test('no assistant messages and no user message at all', () => {
    expect(compactionTurnInfo(turn([]))).toEqual({
      isCompaction: false,
      hasContent: false,
      inFlight: false,
      error: null,
    });
  });
});
