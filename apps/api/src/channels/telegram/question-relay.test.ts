import { describe, expect, it } from 'bun:test';
import { coerceQuestions } from './questions';
import { normalizePendingQuestions } from './question-relay';

describe('normalizePendingQuestions', () => {
  it('parses an array of question entries', () => {
    const got = normalizePendingQuestions([
      { requestID: 'req_1', sessionID: 'ses_a', questions: [{ question: 'Pick' }] },
    ]);
    expect(got).toEqual([{ requestID: 'req_1', sessionID: 'ses_a', questions: [{ question: 'Pick' }] }]);
  });

  it('parses a map keyed by requestID (key becomes requestID)', () => {
    const got = normalizePendingQuestions({
      req_2: { sessionID: 'ses_b', questions: [{ question: 'Q' }] },
    });
    expect(got).toHaveLength(1);
    expect(got[0].requestID).toBe('req_2');
    expect(got[0].sessionID).toBe('ses_b');
    expect(got[0].questions).toEqual([{ question: 'Q' }]);
  });

  it('unwraps a `properties`-nested payload (SSE event shape)', () => {
    const got = normalizePendingQuestions([
      { id: 'req_3', properties: { sessionID: 'ses_c', questions: [{ question: 'X' }] } },
    ]);
    expect(got[0].requestID).toBe('req_3');
    expect(got[0].sessionID).toBe('ses_c');
    expect(got[0].questions).toEqual([{ question: 'X' }]);
  });

  it('drops entries with no requestID/id and tolerates junk', () => {
    expect(normalizePendingQuestions([{ questions: [] }, null, 'x', 3])).toEqual([]);
    expect(normalizePendingQuestions(null)).toEqual([]);
    expect(normalizePendingQuestions(undefined)).toEqual([]);
  });

  it('defaults a missing questions array to []', () => {
    const got = normalizePendingQuestions([{ requestID: 'req_4' }]);
    expect(got[0].questions).toEqual([]);
    expect(got[0].sessionID).toBeNull();
  });
});

describe('coerceQuestions', () => {
  it('coerces question + options (label or value) to QuestionInfo[]', () => {
    const got = coerceQuestions([
      {
        question: 'Capital of France?',
        header: 'Geo',
        multiple: true,
        options: [{ label: 'Paris', description: 'City of Light' }, { value: 'London' }],
      },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].question).toBe('Capital of France?');
    expect(got[0].header).toBe('Geo');
    expect(got[0].multiple).toBe(true);
    expect(got[0].options).toEqual([
      { label: 'Paris', description: 'City of Light' },
      { label: 'London', description: undefined },
    ]);
  });

  it('skips entries with no question text and options with neither label nor value', () => {
    const got = coerceQuestions([
      { question: '  ' },
      { question: 'Ok?', options: [{}, { label: 'yes' }] },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].options).toEqual([{ label: 'yes', description: undefined }]);
  });
});
