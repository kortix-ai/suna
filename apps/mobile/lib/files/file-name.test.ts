import { describe, expect, test } from 'bun:test';

import { availableFileName } from './file-name';

describe('availableFileName', () => {
  test('keeps a free name and numbers a taken one before its extension', () => {
    const taken = new Set(['notes.md', 'notes (1).md', 'README']);
    const has = (name: string) => taken.has(name);
    expect(availableFileName('report.pdf', has)).toBe('report.pdf');
    expect(availableFileName('notes.md', has)).toBe('notes (2).md');
    expect(availableFileName('README', has)).toBe('README (1)');
    expect(availableFileName('.env', (name) => name === '.env')).toBe('.env (1)');
  });
});
