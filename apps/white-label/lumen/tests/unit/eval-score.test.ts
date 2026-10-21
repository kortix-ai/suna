import { describe, expect, test } from 'bun:test';
import key from '../../agent-kit/evals/expected.json';
import { cellCorrect, scoreAnswers, scoreCitations, scoreExtraction } from '../../agent-kit/evals/score';

describe('eval scoring', () => {
  test('cell rules per expectation', () => {
    expect(cellCorrect({ state: 'filled', value: 'Uncapped: neither party’s liability is limited' }, { any: [['uncapped']] })).toBe(true);
    expect(cellCorrect({ state: 'filled', value: true }, { value: true })).toBe(true);
    expect(cellCorrect({ state: 'filled', value: 'Yes - 30 days notice' }, { value: true })).toBe(true);
    expect(cellCorrect({ state: 'not_found', value: null }, { value: false })).toBe(false);
    expect(cellCorrect({ state: 'not_found', value: null }, { absent: true })).toBe(true);
    expect(cellCorrect({ state: 'filled', value: false }, { absent: true })).toBe(true);
    expect(cellCorrect({ state: 'filled', value: 'Not stated in the agreement' }, { absent: true })).toBe(true);
    expect(cellCorrect({ state: 'filled', value: '12 months fees' }, { absent: true })).toBe(false);
    expect(cellCorrect({ state: 'filled', value: 'Brightwater (Customer)' }, { any: [['brightwater'], ['quillon']] })).toBe(false);
  });

  test('extraction over the key: perfect cells score 1.0, one wrong cell is named', () => {
    const cells = Object.entries(key.documents).flatMap(([filename, cols]) =>
      Object.entries(cols).map(([columnKey, exp]) => ({
        filename, columnKey,
        state: 'absent' in exp ? 'not_found' : 'filled',
        value: 'absent' in exp ? null : 'value' in exp ? exp.value : (exp as { any: string[][] }).any.map((g) => g[0]).join(' '),
        citations: [{ filename, status: 'verified' as const }],
      })),
    );
    expect(scoreExtraction(cells, key.documents as never).accuracy).toBe(1);
    cells[0].value = 'wrong';
    const s = scoreExtraction(cells, key.documents as never);
    expect(s.correct).toBe(s.cells - 1);
    expect(s.failures[0]).toContain('mutual-nda-quillon.docx / parties');
  });

  test('citations and answers', () => {
    const c = scoreCitations([{ filename: 'a', status: 'verified' }, { filename: 'a', status: 'relocated' }, { filename: 'a', status: 'unverified' }, { filename: 'a', status: 'verified' }]);
    expect([c.rawPrecision, c.inSourceRate]).toEqual([0.5, 0.75]);
    const s = scoreAnswers(
      [
        { id: 'q1', suite: 'qa', question: 'escrow?', must_cite: ['spa.pdf'], must_contain: [['15%', 'fifteen']] },
        { id: 'r1', suite: 'refusal', question: 'rent?' },
      ],
      [
        { id: 'q1', suite: 'qa', addressed: true, answerMd: 'An escrow of 15% for 18 months.', citations: [{ filename: 'spa.pdf', status: 'verified' }] },
        { id: 'r1', suite: 'refusal', addressed: false, answerMd: 'The documents in this matter do not address this.', citations: [] },
      ],
    );
    expect([s.qa.factRecall, s.qa.citedDocRecall, s.refusal.passed]).toEqual([1, 1, 1]);
  });
});
