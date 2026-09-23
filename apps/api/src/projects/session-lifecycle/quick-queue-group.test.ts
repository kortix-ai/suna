import { describe, expect, test } from 'bun:test';
import {
  QUICK_QUEUE_GROUP_HINT_MIN,
  isGroupableQuickQueueRow,
  quickQueueGroup,
  quickQueueGroupHint,
  groupEndedResponse,
  quickQueueInterruptNote,
  groupRemintsTogether,
} from './quick-queue-group';
import type { SessionLifecycleCommandRow } from './store';

const row = (
  commandId: string,
  payload: Record<string, unknown>,
  result: Record<string, unknown> = {},
): SessionLifecycleCommandRow =>
  ({
    commandId,
    commandType: 'continue_session',
    sessionId: 'sess-1',
    createdAt: new Date('2026-09-21T00:00:00.000Z'),
    payload: { text: commandId, clientMessageId: `client-${commandId}`, ...payload },
    result,
  }) as unknown as SessionLifecycleCommandRow;

const quick = (commandId: string, result: Record<string, unknown> = {}) =>
  row(commandId, { placement: 'transcript' }, result);
const list = (commandId: string) => row(commandId, { placement: 'composer' });
const unplaced = (commandId: string) => row(commandId, {});

describe('isGroupableQuickQueueRow', () => {
  test('only an unheld Quick Queue row is groupable', () => {
    expect(isGroupableQuickQueueRow(quick('a'))).toBe(true);
    expect(isGroupableQuickQueueRow(list('a'))).toBe(false);
    expect(isGroupableQuickQueueRow(unplaced('a'))).toBe(false);
    expect(isGroupableQuickQueueRow(quick('a', { held: true }))).toBe(false);
  });
});

describe('quickQueueGroup', () => {
  test('three consecutive Quick Queue rows are ONE group, in the order given', () => {
    const batch = [quick('a'), quick('b'), quick('c')];
    expect(quickQueueGroup(batch).map((entry) => entry.commandId)).toEqual(['a', 'b', 'c']);
  });

  test('a Queue List row is never grouped and never reordered', () => {
    // Quick Queue sorts ahead of Queue List (`inbox-order.ts` lane 0 vs 1), so
    // a composer row can only ever END the group, never sit inside it.
    expect(quickQueueGroup([quick('a'), quick('b'), list('c')]).map((e) => e.commandId)).toEqual([
      'a',
      'b',
    ]);
    // A composer HEAD groups alone: it gets its own turn and its own answer.
    expect(quickQueueGroup([list('c'), quick('a')]).map((e) => e.commandId)).toEqual(['c']);
  });

  test('an UNPLACED row ends the group — it is not a correction to work in flight', () => {
    expect(quickQueueGroup([quick('a'), unplaced('b'), quick('c')]).map((e) => e.commandId)).toEqual(
      ['a'],
    );
    expect(quickQueueGroup([unplaced('b'), quick('c')]).map((e) => e.commandId)).toEqual(['b']);
  });

  test('a HELD row is never part of a group — the user took it out of the line', () => {
    expect(
      quickQueueGroup([quick('a'), quick('b', { held: true }), quick('c')]).map((e) => e.commandId),
    ).toEqual(['a']);
    expect(quickQueueGroup([quick('a', { held: true }), quick('b')]).map((e) => e.commandId)).toEqual(
      ['a'],
    );
  });

  test('one row is one group — N=1 is the ordinary delivery', () => {
    expect(quickQueueGroup([quick('a')]).map((e) => e.commandId)).toEqual(['a']);
    expect(quickQueueGroup([])).toEqual([]);
  });
});

// A GROUP IS A CONTIGUOUS FIFO RUN, NEVER A SET OF ROWS THAT HAPPEN TO BE IN
// HAND. Measured 2026-09-22, 2 of 2 runs ("T3 burst over text"): three Quick
// Queue prompts ended a streaming response, each row was requeued on its own
// clock (available_at 47.730 / 49.224 / 47.496 s), and the 1 s scheduler drain
// claimed rows 1 and 3 while row 2 was still 1.5 s out. `quickQueueGroup` saw a
// batch of two groupable rows and merged them — ACROSS row 2 — so row 2 went
// out ~3 s later, after the answer to rows 1 and 3, and one prompt was never
// answered at all.
//
// The batch alone cannot tell a run from a set, so the drain hands over the
// earliest row it left behind and the run stops there.
describe('quickQueueGroup — a row the drain did NOT claim breaks the run', () => {
  test('a gap INSIDE the batch ends the group at the gap', () => {
    expect(
      quickQueueGroup([quick('a'), quick('c')], { firstUnclaimed: quick('b') }).map(
        (e) => e.commandId,
      ),
    ).toEqual(['a']);
  });

  test('a gap ahead of the whole batch leaves the head to answer for itself', () => {
    // Nothing may jump an unclaimed older row. The head alone is safe: the
    // admission gate refuses it on `older_prompt_pending` (`inbox-admission.ts`).
    expect(
      quickQueueGroup([quick('b'), quick('c')], { firstUnclaimed: quick('a') }).map(
        (e) => e.commandId,
      ),
    ).toEqual(['b']);
  });

  test('a row left behind AFTER the batch does not shorten the group', () => {
    expect(
      quickQueueGroup([quick('a'), quick('b')], { firstUnclaimed: quick('c') }).map(
        (e) => e.commandId,
      ),
    ).toEqual(['a', 'b']);
  });

  test('no gap is the ordinary case — the whole run groups', () => {
    expect(
      quickQueueGroup([quick('a'), quick('b'), quick('c')], { firstUnclaimed: null }).map(
        (e) => e.commandId,
      ),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('quickQueueGroupHint', () => {
  test('the hint names how many messages the reply has to address', () => {
    const hint = quickQueueGroupHint(3) ?? '';
    expect(hint).toContain('3');
    expect(hint.toLowerCase()).toContain('every one of them');
  });

  test('a group of one gets no hint — there is nothing to merge', () => {
    expect(QUICK_QUEUE_GROUP_HINT_MIN).toBe(2);
    expect(quickQueueGroupHint(1)).toBeNull();
    expect(quickQueueGroupHint(0)).toBeNull();
  });
});

describe('a prompt that ENDED a streaming response says so to the model', () => {
  // Measured 2026-09-21 on a real sandbox: a 20-paragraph essay was stopped by
  // five Quick Queue prompts. The grouped reply answered all five — and then
  // restarted the essay from "P1:" and wrote for two more minutes. Nothing told
  // the model the interruption was deliberate, so the unfinished request was
  // still open work in its context.
  test('the note tells the model not to resume the reply it was stopped in', () => {
    const note = quickQueueInterruptNote(true);
    expect(note).toContain('on purpose');
    expect(note).toContain('Do not resume');
    // IT DOES NOT MAKE DeepSeek OBEY, and no wording tried does. Measured
    // 2026-09-22 on real sandboxes: a response stopped while it streamed in
    // REASONING leaves an aborted message with reasoning and no answer text,
    // so the cancelled request still reads as unanswered. DeepSeek V4.1 Flash
    // rewrote the whole essay in the next turn before answering the new
    // prompt, 3 of 3 runs with this note and 3 of 3 with a stronger one that
    // named the request cancelled (sessions 6966a82c, 3fc5431e, f99f6f05).
    // Open for the owner; the stop itself is unaffected.
  });
  test('a delivery that ended nothing carries no note', () => {
    expect(quickQueueInterruptNote(false)).toBeNull();
  });
  test('the marker is read off the durable row, from any row of the group', () => {
    const row = (result: unknown) => ({ result }) as never;
    expect(groupEndedResponse([row(null), row({ ended_response: true })])).toBe(true);
    expect(groupEndedResponse([row({}), row({ ended_response: false })])).toBe(false);
    expect(groupEndedResponse([])).toBe(false);
  });
});

// A GROUP MINTS AS ONE.
//
// Measured 2026-09-22 on a real sandbox (session 37eb6e96, T3 burst over a
// streaming essay). Group [Request 1, Request 2]: Request 1 had waited out the
// interrupt, so it was LIFTED above the transcript to `msg_0ca6ad25f0002V`;
// Request 2 was claimed fresh, nothing said it had waited, and it went out
// under its own client id `msg_0ca6a8a77003Qo` — BELOW its predecessor. The
// SDK orders placed messages by id, so the tab drew Request 2 above Request 1.
// Both were answered; the order was wrong.
describe('groupRemintsTogether', () => {
  const waitedRow = (commandId: string) =>
    row(commandId, { placement: 'transcript', remintOnDelivery: true });
  const refusedRow = (commandId: string) =>
    row(commandId, { placement: 'transcript' }, { admission_reason: 'turn_active' });

  test('one row of the group that waited lifts the WHOLE group', () => {
    expect(groupRemintsTogether([waitedRow('a'), quick('b')])).toBe(true);
    expect(groupRemintsTogether([quick('a'), refusedRow('b')])).toBe(true);
  });

  test('a group where nothing waited keeps its client ids', () => {
    expect(groupRemintsTogether([quick('a'), quick('b')])).toBe(false);
  });

  test('a single delivery is not a group — it decides for itself', () => {
    expect(groupRemintsTogether([waitedRow('a')])).toBe(false);
    expect(groupRemintsTogether([])).toBe(false);
  });
});
