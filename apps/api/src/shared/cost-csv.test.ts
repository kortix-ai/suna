import { describe, expect, test } from 'bun:test';

import { CSV_ROW_CAP, toCsv } from './cost-csv';

describe('toCsv', () => {
  test('emits a header row followed by data rows', () => {
    expect(toCsv(['a', 'b'], [[1, 2]])).toBe('a,b\r\n1,2');
  });

  test('emits only the header row for an empty row set', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });

  test('joins multiple data rows with CRLF', () => {
    expect(toCsv(['a'], [[1], [2], [3]])).toBe('a\r\n1\r\n2\r\n3');
  });

  test('quotes values containing a comma', () => {
    expect(toCsv(['name'], [['Smith, Jane']])).toBe('name\r\n"Smith, Jane"');
  });

  test('escapes embedded double quotes by doubling them', () => {
    expect(toCsv(['name'], [['say "hi"']])).toBe('name\r\n"say ""hi"""');
  });

  test('quotes a value that is only double quotes and doubles every one of them', () => {
    expect(toCsv(['v'], [['""']])).toBe('v\r\n""""""');
  });

  test('quotes values containing a newline', () => {
    expect(toCsv(['note'], [['line1\nline2']])).toBe('note\r\n"line1\nline2"');
  });

  test('quotes values containing a carriage return', () => {
    expect(toCsv(['note'], [['line1\rline2']])).toBe('note\r\n"line1\rline2"');
  });

  test('renders null as an empty field', () => {
    expect(toCsv(['a', 'b'], [[null, 1]])).toBe('a,b\r\n,1');
  });

  test('leaves a plain string field unquoted', () => {
    expect(toCsv(['name'], [['Acme Corp']])).toBe('name\r\nAcme Corp');
  });

  test('leaves a plain number field unquoted', () => {
    expect(toCsv(['cost'], [[12.5]])).toBe('cost\r\n12.5');
  });

  test('quotes a header value that itself needs quoting', () => {
    expect(toCsv(['a,b'], [[1]])).toBe('"a,b"\r\n1');
  });

  test.each([
    ['=', '=SUM(A1)'],
    ['+', '+1+1'],
    ['-', '-1+1'],
    ['@', '@SUM(A1)'],
  ])('neutralises a leading formula character: %s', (_label, value) => {
    expect(toCsv(['v'], [[value]])).toBe(`v\r\n"'${value}"`);
  });

  test('neutralising a formula prefix still applies comma-quoting when the value also has a comma', () => {
    expect(toCsv(['v'], [['=1,2']])).toBe(`v\r\n"'=1,2"`);
  });

  test('does not neutralise a formula character that is not in the leading position', () => {
    expect(toCsv(['v'], [['total=5']])).toBe('v\r\ntotal=5');
  });

  test('renders a zero number as 0, not empty', () => {
    expect(toCsv(['count'], [[0]])).toBe('count\r\n0');
  });

  test('renders a negative number unquoted and un-neutralised, not as formula-injection text', () => {
    expect(toCsv(['v'], [[-1.5]])).toBe('v\r\n-1.5');
  });

  test('still neutralises a negative-looking value that arrives as a string, not a number', () => {
    expect(toCsv(['v'], [['-1.5']])).toBe(`v\r\n"'-1.5"`);
  });

  test.each([
    ['space', ' =SUM(A1)'],
    ['tab', '\t=SUM(A1)'],
    ['non-breaking space', ' =SUM(A1)'],
  ])('neutralises and quotes a formula prefix behind leading whitespace: %s', (_label, value) => {
    expect(toCsv(['v'], [[value]])).toBe(`v\r\n"'${value}"`);
  });

  test('neutralising a formula prefix still doubles an embedded double quote in the same value', () => {
    expect(toCsv(['v'], [['=say "hi"']])).toBe(`v\r\n"'=say ""hi"""`);
  });
});

describe('CSV_ROW_CAP', () => {
  test('is 10,000', () => {
    expect(CSV_ROW_CAP).toBe(10_000);
  });
});
