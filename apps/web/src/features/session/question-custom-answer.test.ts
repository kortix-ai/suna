import type { QuestionInfo } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { planQuestionCustomAnswer } from './question-custom-answer';

const choice: QuestionInfo = {
  header: 'Mode',
  question: 'Choose a mode.',
  custom: false,
  options: [
    { label: 'Blue', description: 'First' },
    { label: 'Green', description: 'Second' },
  ],
};

describe('question custom answers', () => {
  test('refuses typed text for choice-only questions, including an option label', () => {
    for (const text of ['Purple', 'Blue']) {
      expect(planQuestionCustomAnswer([choice], [[]], 0, text)).toEqual({ kind: 'ignore' });
    }
  });
  test('does not append a note or submit from the confirmation tab', () => {
    expect(planQuestionCustomAnswer([choice], [['Blue']], 1, 'Extra note')).toEqual({
      kind: 'ignore',
    });
  });
  test('trims and submits a custom single answer when custom is omitted', () => {
    const { custom, ...question } = choice;
    expect(planQuestionCustomAnswer([question], [[]], 0, ' Purple  ')).toEqual({
      kind: 'reply',
      answers: [['Purple']],
    });
  });
  test('replaces the current single answer and advances without changing other answers', () => {
    const questions = [choice, { ...choice, custom: true }];
    expect(planQuestionCustomAnswer(questions, [['Blue'], ['Green']], 1, 'Purple')).toEqual({
      kind: 'update',
      answers: [['Blue'], ['Purple']],
      tab: 2,
    });
  });
  test('adds custom text to multiple selections without advancing or mutating the source', () => {
    const questions = [{ ...choice, custom: true, multiple: true }];
    const answers = [['Blue']];
    expect(planQuestionCustomAnswer(questions, answers, 0, 'Purple')).toEqual({
      kind: 'update',
      answers: [['Blue', 'Purple']],
      tab: 0,
    });
    expect(answers).toEqual([['Blue']]);
    expect(planQuestionCustomAnswer(questions, answers, 0, 'Blue')).toEqual({ kind: 'ignore' });
  });
  test('ignores empty input and a missing question', () => {
    expect(planQuestionCustomAnswer([{ ...choice, custom: true }], [[]], 0, '  ')).toEqual({
      kind: 'ignore',
    });
    expect(planQuestionCustomAnswer([], [], 0, 'Purple')).toEqual({ kind: 'ignore' });
  });
});
