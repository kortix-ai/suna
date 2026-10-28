import { describe, expect, test } from 'bun:test';
import { parseQuestionButton, questionButtonData } from './question-token';

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
