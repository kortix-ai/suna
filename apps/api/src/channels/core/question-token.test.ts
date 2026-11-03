import { describe, expect, test } from 'bun:test';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { parseQuestionButton, parseQuestionControl, questionButtonData, questionDoneData, questionPageData } from './question-token';

// A question button's data is persisted in chats: a message posted before a
// deploy must still parse after it.

const ID = '00000000-0000-4000-8000-000000000000';

describe('question button data', () => {
  test('the first question keeps the format buttons were posted with', () => {
    expect(questionButtonData(ID, 1)).toBe(`kq:${ID}:1`);
    expect(questionButtonData(ID, 1, 0)).toBe(`kq:${ID}:1`);
    expect(parseQuestionButton(`kq:${ID}:1`)).toEqual({ pendingId: ID, question: 0, index: 1 });
  });

  test('a later question round-trips, in at most 45 bytes', () => {
    for (const [question, option] of [
      [1, 0],
      [3, 5],
      [99, 99],
    ] as const) {
      const data = questionButtonData(ID, option, question);
      expect(data).toBe(`kq:${ID}:${question}.${option}`);
      expect(parseQuestionButton(data)).toEqual({ pendingId: ID, question, index: option });
    }
    expect(Buffer.byteLength(questionButtonData(ID, 99, 99))).toBe(45);
  });

  test("the longest button data fits each platform's cap", () => {
    const caps = Object.values(CHANNELS).flatMap((d) => ('buttons' in d && 'dataBytes' in d.buttons ? [d.buttons.dataBytes] : []));
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) expect(Buffer.byteLength(questionButtonData(ID, 99, 99))).toBeLessThanOrEqual(cap);
  });

  test('data Kortix did not post parses as nothing', () => {
    for (const data of [
      `kq:${ID}:0.1`,
      `kq:${ID}:01`,
      `kq:${ID}:100`,
      `kq:${ID}:1.100`,
      `kq:${ID}:1.`,
      `kq:${ID}:`,
      `kq:${ID}:-1`,
      'kq:not-a-uuid:0',
      `qa_0_1`,
      '',
    ]) {
      expect(parseQuestionButton(data)).toBeNull();
    }
  });
});

describe('question control data (Done, a page turn)', () => {
  test('Done and a page turn round-trip in the button format, in at most 46 bytes, and are no option', () => {
    expect(questionDoneData(ID, 0)).toBe(`kq:${ID}:d`);
    expect(questionDoneData(ID, 2)).toBe(`kq:${ID}:2.d`);
    expect(questionPageData(ID, 0, 1)).toBe(`kq:${ID}:p1`);
    expect(questionPageData(ID, 3, 16)).toBe(`kq:${ID}:3.p16`);
    expect(parseQuestionControl(`kq:${ID}:d`)).toEqual({ pendingId: ID, question: 0, control: 'done' });
    expect(parseQuestionControl(`kq:${ID}:2.d`)).toEqual({ pendingId: ID, question: 2, control: 'done' });
    expect(parseQuestionControl(`kq:${ID}:3.p16`)).toEqual({ pendingId: ID, question: 3, control: 16 });
    expect(parseQuestionControl(`kq:${ID}:p0`)).toEqual({ pendingId: ID, question: 0, control: 0 });
    expect(Buffer.byteLength(questionPageData(ID, 99, 99))).toBe(46);
    for (const data of [questionDoneData(ID, 1), questionPageData(ID, 1, 2)]) expect(parseQuestionButton(data)).toBeNull();
    expect(parseQuestionControl(questionButtonData(ID, 1, 1))).toBeNull();
  });

  test('control data Kortix did not post parses as nothing', () => {
    for (const data of [`kq:${ID}:0.d`, `kq:${ID}:p`, `kq:${ID}:p01`, `kq:${ID}:p100`, `kq:${ID}:1.dd`, `kq:${ID}:D`, 'kq:not-a-uuid:d', '']) {
      expect(parseQuestionControl(data)).toBeNull();
    }
  });
});
