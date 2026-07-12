import { describe, expect, test } from 'bun:test';
import { getFileType } from './file-utils';

describe('getFileType', () => {
  test('maps document/data extensions to their viewer categories', () => {
    expect(getFileType('report.pdf')).toBe('pdf');
    expect(getFileType('data.csv')).toBe('csv');
    expect(getFileType('data.tsv')).toBe('csv');
    expect(getFileType('book.xlsx')).toBe('spreadsheet');
    expect(getFileType('legacy.xls')).toBe('spreadsheet');
    expect(getFileType('notes.md')).toBe('markdown');
    expect(getFileType('photo.jpeg')).toBe('image');
  });

  test('is case-insensitive on the extension', () => {
    expect(getFileType('REPORT.PDF')).toBe('pdf');
    expect(getFileType('Data.CSV')).toBe('csv');
  });

  test('falls back to "other" for unknown or missing extensions', () => {
    expect(getFileType('archive.xyz')).toBe('other');
    expect(getFileType('README')).toBe('other');
  });

  test('uses only the last extension segment', () => {
    expect(getFileType('export.backup.csv')).toBe('csv');
    expect(getFileType('v1.2.3.pdf')).toBe('pdf');
  });
});
