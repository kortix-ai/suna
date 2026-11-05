import { describe, expect, test } from 'bun:test';
import { parseParkedQuestionAnswer } from './answered-question-step';

describe('parseParkedQuestionAnswer', () => {
  test('one question: the quoted question, then the answer', () => {
    expect(parseParkedQuestionAnswer('You asked:\n> Which colour?\n\nblue')).toEqual({
      questions: [{ question: 'Which colour?' }],
      answers: [['blue']],
    });
  });

  test('several questions: one block each, paired by position; a multi-line question stays whole', () => {
    const text = 'You asked:\n> Which connector?\n> Two flavors.\nOAuth app (Recommended)\n\n> Agent name?\nmail-assistant';
    expect(parseParkedQuestionAnswer(text)).toEqual({
      questions: [{ question: 'Which connector?\nTwo flavors.' }, { question: 'Agent name?' }],
      answers: [['OAuth app (Recommended)'], ['mail-assistant']],
    });
  });

  test('any other text is not an answer', () => {
    expect(parseParkedQuestionAnswer('Please answer: blue')).toBeNull();
    expect(parseParkedQuestionAnswer('You asked:\nnothing quoted')).toBeNull();
  });
});
