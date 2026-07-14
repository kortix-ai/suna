import { describe, expect, test } from 'bun:test';
import type { QuestionInfo } from '../slack/types';
import {
  answerLabelFromKeyboard,
  buildQuestionKeyboard,
  decodeQuestionCallback,
  encodeQuestionCallback,
  isQuestionCallback,
  renderQuestionHtml,
} from './questions';

const q = (
  question: string,
  options: string[],
  extra: Partial<QuestionInfo> = {},
): QuestionInfo => ({
  question,
  options: options.map((label) => ({ label })),
  ...extra,
});

describe('question callback encode/decode', () => {
  test('round-trips a question/option index pair', () => {
    expect(encodeQuestionCallback(0, 2)).toBe('kxq:0:2');
    expect(decodeQuestionCallback('kxq:0:2')).toEqual({ questionIndex: 0, optionIndex: 2 });
    expect(decodeQuestionCallback(encodeQuestionCallback(3, 4))).toEqual({
      questionIndex: 3,
      optionIndex: 4,
    });
  });

  test('stays within Telegram 64-byte callback_data cap even for large indices', () => {
    expect(Buffer.byteLength(encodeQuestionCallback(999, 999))).toBeLessThanOrEqual(64);
  });

  test('rejects foreign / malformed callback data', () => {
    expect(decodeQuestionCallback(undefined)).toBeNull();
    expect(decodeQuestionCallback('')).toBeNull();
    expect(decodeQuestionCallback('other:0:1')).toBeNull();
    expect(decodeQuestionCallback('kxq:0')).toBeNull();
    expect(decodeQuestionCallback('kxq:a:b')).toBeNull();
    expect(isQuestionCallback('kxq:1:0')).toBe(true);
    expect(isQuestionCallback('teams_answer')).toBe(false);
  });
});

describe('buildQuestionKeyboard', () => {
  test('one button per option, one option per row, callback carries the index', () => {
    const kb = buildQuestionKeyboard([q('Ship it?', ['Yes', 'No'])]);
    expect(kb).toEqual([
      [{ text: 'Yes', callbackData: 'kxq:0:0' }],
      [{ text: 'No', callbackData: 'kxq:0:1' }],
    ]);
  });

  test('indexes options across multiple questions independently', () => {
    const kb = buildQuestionKeyboard([q('A?', ['a1']), q('B?', ['b1', 'b2'])]);
    expect(kb.map((row) => row[0].callbackData)).toEqual(['kxq:0:0', 'kxq:1:0', 'kxq:1:1']);
  });

  test('skips empty labels and truncates over-long ones', () => {
    const long = 'x'.repeat(80);
    const kb = buildQuestionKeyboard([q('?', ['ok', '', long])]);
    expect(kb).toHaveLength(2);
    expect(kb[1][0].text.endsWith('…')).toBe(true);
    expect(kb[1][0].text.length).toBeLessThanOrEqual(60);
  });
});

describe('answerLabelFromKeyboard', () => {
  const keyboard = [
    [{ text: 'Yes', callback_data: 'kxq:0:0' }],
    [{ text: 'No', callback_data: 'kxq:0:1' }],
  ];

  test('recovers the tapped option label by matching callback_data', () => {
    expect(answerLabelFromKeyboard(keyboard, 'kxq:0:0')).toBe('Yes');
    expect(answerLabelFromKeyboard(keyboard, 'kxq:0:1')).toBe('No');
  });

  test('duplicate labels across questions still resolve to the tapped button', () => {
    const dup = [
      [{ text: 'Maybe', callback_data: 'kxq:0:0' }],
      [{ text: 'Maybe', callback_data: 'kxq:1:0' }],
    ];
    expect(answerLabelFromKeyboard(dup, 'kxq:1:0')).toBe('Maybe');
  });

  test('returns null for a missing button or missing keyboard', () => {
    expect(answerLabelFromKeyboard(keyboard, 'kxq:9:9')).toBeNull();
    expect(answerLabelFromKeyboard(undefined, 'kxq:0:0')).toBeNull();
    expect(answerLabelFromKeyboard(keyboard, undefined)).toBeNull();
  });
});

describe('renderQuestionHtml', () => {
  test('single question: no numbering, tap-or-reply hint', () => {
    const html = renderQuestionHtml([q('Deploy now?', ['Yes', 'No'])]);
    expect(html).toContain('Deploy now?');
    expect(html).not.toMatch(/^1\. /);
    expect(html).toContain('Tap an option');
  });

  test('multiple questions are numbered', () => {
    const html = renderQuestionHtml([q('First?', ['a']), q('Second?', ['b'])]);
    expect(html).toContain('1. First?');
    expect(html).toContain('2. Second?');
  });

  test('question with no options nudges toward a typed reply', () => {
    const html = renderQuestionHtml([{ question: 'What is the deadline?', options: [] }]);
    expect(html).toContain('Reply in the chat');
    expect(html).not.toContain('Tap an option');
  });

  test('escapes HTML-significant characters in the question', () => {
    const html = renderQuestionHtml([q('Use <script> & co?', ['ok'])]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
