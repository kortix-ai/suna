import { describe, expect, test } from 'bun:test';

import { parseQuestionAnswersFromOutput } from './question-helpers';

describe('parseQuestionAnswersFromOutput', () => {
  test('pairs answers with questions and pads to the question count', () => {
    const output = 'User answered: "Pick a color"="Blue", "Size"="L"';
    expect(parseQuestionAnswersFromOutput(output, 3)).toEqual([['Blue'], ['L'], []]);
  });

  test('more answers than questions keeps every answer', () => {
    expect(parseQuestionAnswersFromOutput('"a"="1" "b"="2"', 1)).toEqual([['1'], ['2']]);
  });

  test('no answer pairs is null', () => {
    expect(parseQuestionAnswersFromOutput('', 2)).toBeNull();
    expect(parseQuestionAnswersFromOutput('dismissed', 2)).toBeNull();
  });
});
