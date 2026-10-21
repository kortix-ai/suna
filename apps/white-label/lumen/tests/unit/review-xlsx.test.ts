import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { reviewSheets } from '../../src/lib/review-cells';
import { colName, excelDate, xlsxBytes } from '../../src/lib/xlsx';

const view = {
  title: 'Project Aster: key terms',
  columns: [
    { key: 'cap', label: 'Liability cap', format: 'money' as const },
    { key: 'rise', label: 'Rent increase', format: 'percent' as const },
    { key: 'start', label: 'Effective date', format: 'date' as const },
    { key: 'events', label: 'Termination events', format: 'list' as const },
    { key: 'law', label: 'Law <&>', format: 'text' as const },
  ],
  documents: [{ _id: 'd1', filename: 'lease.pdf' }],
  cells: [
    { documentId: 'd1', columnKey: 'cap', state: 'filled', value: { amount: 2000000, currency: 'GBP' }, reviewStatus: 'verified', citations: [{ filename: 'lease.pdf', page: 2, quote: 'capped at GBP 2,000,000', status: 'verified' }] },
    { documentId: 'd1', columnKey: 'rise', state: 'filled', value: 8, reviewStatus: 'none', citations: [] },
    { documentId: 'd1', columnKey: 'start', state: 'filled', value: '2026-04-01', reviewStatus: 'none', citations: [] },
    { documentId: 'd1', columnKey: 'events', state: 'filled', value: ['Breach', 'Insolvency'], reviewStatus: 'none', citations: [] },
    { documentId: 'd1', columnKey: 'law', state: 'not_found', value: null, reviewStatus: 'none', citations: [] },
  ],
};

describe('review export to Excel', () => {
  test('column letters and Excel dates', () => {
    expect([colName(0), colName(25), colName(26), colName(701)]).toEqual(['A', 'Z', 'AA', 'ZZ']);
    expect(excelDate('2026-04-01')).toBe(46113);
    expect(excelDate('P2Y')).toBeNull();
  });

  test('typed cells: money as text, percent and date typed, lists joined, a silent document says so; citations on their own sheet', async () => {
    const zip = await JSZip.loadAsync(await xlsxBytes(reviewSheets(view)));
    const wb = await zip.file('xl/workbook.xml')!.async('string');
    // Excel forbids ':' in a sheet name.
    expect(wb).toContain('name="Project Aster  key terms"');
    expect(wb).toContain('name="Citations"');
    const s1 = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(s1).toContain('<c r="B2" s="3" t="inlineStr"><is><t xml:space="preserve">GBP 2000000</t></is></c>');
    expect(s1).toContain('<c r="C2" s="3" t="inlineStr"><is><t xml:space="preserve">verified</t></is></c>');
    expect(s1).toContain('<c r="D2" s="1"><v>0.08</v></c>');
    expect(s1).toContain('<c r="F2" s="2"><v>46113</v></c>');
    expect(s1).toContain('Breach; Insolvency');
    expect(s1).toContain('Not addressed');
    expect(s1).toContain('Law &lt;&amp;&gt;');
    const s2 = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    expect(s2).toContain('capped at GBP 2,000,000');
    expect(s2).toContain('<c r="D2"><v>2</v></c>');
  });
});
