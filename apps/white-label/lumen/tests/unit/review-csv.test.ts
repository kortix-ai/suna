import { describe, expect, test } from 'bun:test';
import { toCsv } from '../../src/lib/csv';
import { cellText, reviewCsv, yesNo } from '../../src/lib/review-cells';

const cite = (quote: string, status = 'verified') => ({ filename: 'msa, "final".pdf', page: 3, quote, status });

describe('review CSV export', () => {
  const view = {
    columns: [
      { key: 'liability_cap', label: 'Liability cap', format: 'text' as const },
      { key: 'auto_renewal', label: 'Auto-renewal', format: 'yes_no' as const },
    ],
    documents: [{ _id: 'd1', filename: 'msa, "final".pdf' }, { _id: 'd2', filename: 'nda.docx' }],
    cells: [
      { documentId: 'd1', columnKey: 'liability_cap', state: 'filled', value: 'AI: capped', edited: true, reviewStatus: 'none', citations: [cite('liability shall not be limited,\nin any way')] },
      { documentId: 'd1', columnKey: 'auto_renewal', state: 'filled', value: true, edited: false, reviewStatus: 'verified', citations: [cite('renews for "successive" terms')] },
      { documentId: 'd2', columnKey: 'liability_cap', state: 'not_found', value: null, edited: false, reviewStatus: 'flagged', citations: [] },
      { documentId: 'd2', columnKey: 'auto_renewal', state: 'needs_review', value: 'No', edited: false, reviewStatus: 'none', citations: [cite('made up', 'unverified')] },
    ],
  };

  test('one row per document: effective value, review state, and every citation', () => {
    const rows = reviewCsv(view);
    expect(rows[0]).toEqual(['Document', 'Liability cap', 'Liability cap (review)', 'Auto-renewal', 'Auto-renewal (review)', 'Citations']);
    expect(rows[1].slice(0, 5)).toEqual(['msa, "final".pdf', 'AI: capped', 'edited', 'Yes', 'verified']);
    expect(rows[2].slice(0, 5)).toEqual(['nda.docx', 'Not addressed', 'flagged', 'No', '']);
    expect(rows[2][5]).toBe('Auto-renewal: msa, "final".pdf p.3 (not found in source): "made up"');
  });

  test('commas, quotes and newlines inside citations survive RFC 4180 quoting', () => {
    const csv = toCsv(reviewCsv(view));
    expect(csv).toContain('"msa, ""final"".pdf"');
    expect(csv).toContain('"Liability cap: msa, ""final"".pdf p.3: ""liability shall not be limited,\nin any way""\nAuto-renewal: ');
    // 1 header + 2 data rows; the newline inside a quoted field does not start a row.
    expect(csv.split('\r\n')).toHaveLength(3);
  });

  test('yes/no reads booleans and yes/no strings; other text stays text', () => {
    expect([yesNo(true), yesNo('Yes, 90 days'), yesNo('no'), yesNo('Unclear')]).toEqual([true, true, false, null]);
    expect(cellText({ documentId: 'x', columnKey: 'k', state: 'filled', value: { amount: 500000, currency: 'EUR' }, citations: [] }, 'money')).toBe('EUR 500000');
  });
});
