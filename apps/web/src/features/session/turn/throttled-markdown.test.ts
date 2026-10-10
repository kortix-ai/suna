import { describe, expect, test } from 'bun:test';

import { holdBackTableHeader } from './throttled-markdown';

describe('holdBackTableHeader', () => {
  test('holds back a header row until its separator arrives', () => {
    expect(holdBackTableHeader('Intro\n\n| Name | Age |')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name')).toBe('Intro\n');
  });

  test('holds back a header and a half-written separator', () => {
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n|---')).toBe('Intro\n');
    expect(holdBackTableHeader('Intro\n\n| Name | Age |\n| --- |')).toBe('Intro\n');
  });

  test('shows the table once the separator is complete', () => {
    const text = 'Intro\n\n| Name | Age |\n| --- | --- |';
    expect(holdBackTableHeader(text)).toBe(text);
  });

  test('leaves body rows and plain text alone', () => {
    const rows = 'Intro\n\n| Name | Age |\n|---|---|\n| Ada | 36';
    expect(holdBackTableHeader(rows)).toBe(rows);
    expect(holdBackTableHeader('no table here')).toBe('no table here');
  });
});
