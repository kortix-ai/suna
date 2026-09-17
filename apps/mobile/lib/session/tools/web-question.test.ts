import { describe, expect, test } from 'bun:test';

import {
  parseQuestionsInput,
  questionFallbackLabel,
  questionTrigger,
  resolveQuestionAnswers,
} from './web-question';

const TWO = parseQuestionsInput([
  { question: 'Which stack?', header: 'Stack', options: [{ label: 'Next', description: 'React' }, { label: 'Vue' }] },
  { question: 'Deploy?', options: [{ label: 'Yes' }, { nope: true }] },
]);

describe('question input', () => {
  test('keeps well-formed questions and options only', () => {
    expect(TWO).toEqual([
      {
        question: 'Which stack?',
        header: 'Stack',
        options: [{ label: 'Next', description: 'React' }, { label: 'Vue', description: undefined }],
      },
      { question: 'Deploy?', header: undefined, options: [{ label: 'Yes', description: undefined }] },
    ]);
    expect(parseQuestionsInput('nope')).toEqual([]);
    expect(parseQuestionsInput([null, 3])).toEqual([]);
  });

  test('a question without text falls back to its header, then its position', () => {
    expect(questionFallbackLabel({ question: '', header: ' Stack ', options: [] }, 0)).toBe('Stack');
    expect(questionFallbackLabel({ question: '', options: [] }, 1)).toBe('Question 2');
  });
});

describe('question answers', () => {
  test('metadata answers win', () => {
    expect(resolveQuestionAnswers([['Next'], []], '"Which stack?"="Vue"', 2)).toEqual([['Next'], []]);
  });

  test('otherwise parsed from the output pairs', () => {
    expect(resolveQuestionAnswers(undefined, '"Which stack?"="Vue" "Deploy?"="Yes"', 2)).toEqual([['Vue'], ['Yes']]);
    expect(resolveQuestionAnswers([], '', 2)).toEqual([]);
  });
});

describe('question trigger', () => {
  test('an active question shows the waiting shimmer and nothing else', () => {
    expect(questionTrigger({ total: 1, answers: [['Next']], hasActiveQuestion: true })).toEqual({
      label: 'Question',
      waiting: true,
      subtitle: undefined,
      badge: undefined,
    });
  });

  test('one answered question: its answer is the subtitle', () => {
    expect(questionTrigger({ total: 1, answers: [['Next', 'Vue']], hasActiveQuestion: false })).toEqual({
      label: 'Question',
      waiting: false,
      subtitle: 'Next, Vue',
      badge: undefined,
    });
  });

  test('several questions: "N of M answered" while partial, and an N/M badge', () => {
    expect(questionTrigger({ total: 2, answers: [['Vue'], []], hasActiveQuestion: false })).toEqual({
      label: 'Questions',
      waiting: false,
      subtitle: '1 of 2 answered',
      badge: '1/2',
    });
    expect(questionTrigger({ total: 2, answers: [['Vue'], ['Yes']], hasActiveQuestion: false })).toEqual({
      label: 'Questions',
      waiting: false,
      subtitle: undefined,
      badge: '2/2',
    });
    expect(questionTrigger({ total: 2, answers: [], hasActiveQuestion: false }).badge).toBeUndefined();
  });
});
