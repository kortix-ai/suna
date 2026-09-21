import { describe, expect, test } from 'bun:test';
import {
  QUICK_QUEUE_GROUP_HINT_MIN,
  isGroupableQuickQueueRow,
  quickQueueGroup,
  quickQueueGroupHint,
  groupEndedResponse,
  quickQueueInterruptNote,
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
