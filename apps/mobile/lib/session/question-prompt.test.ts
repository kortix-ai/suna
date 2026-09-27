import { describe, expect, test } from 'bun:test';
import { pickQuestionOption, questionStepAnswer, questionStepLabel } from './question-prompt';

const single = { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] };
const multi = { ...single, multiple: true };

describe('questionStepAnswer', () => {
  test('single choice sends the pick when nothing is typed', () => {
    expect(questionStepAnswer(single, ['A'], '  ')).toEqual(['A']);
  });

  test('single choice sends the typed text instead of the pick', () => {
    expect(questionStepAnswer(single, ['A'], ' Other ')).toEqual(['Other']);
  });

  test('multi choice sends the picks plus the typed text once', () => {
    expect(questionStepAnswer(multi, ['A'], 'C')).toEqual(['A', 'C']);
    expect(questionStepAnswer(multi, ['A'], 'A')).toEqual(['A']);
  });

  test('ignores typed text when custom answers are off', () => {
    expect(questionStepAnswer({ ...single, custom: false }, [], 'x')).toEqual([]);
  });
});

describe('pickQuestionOption', () => {
  test('single choice replaces the pick', () => {
    expect(pickQuestionOption(single, ['A'], 'B')).toEqual(['B']);
  });

  test('multi choice toggles the pick', () => {
    expect(pickQuestionOption(multi, ['A'], 'B')).toEqual(['A', 'B']);
    expect(pickQuestionOption(multi, ['A', 'B'], 'A')).toEqual(['B']);
  });
});

describe('questionStepLabel', () => {
  test('counts steps only when there is more than one question', () => {
    expect(questionStepLabel(0, 1)).toBeNull();
    expect(questionStepLabel(1, 3)).toBe('2 of 3');
  });
});
