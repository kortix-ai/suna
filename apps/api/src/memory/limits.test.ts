import { describe, expect, test } from 'bun:test';
import { checkPage, MemoryError, titleKey } from './limits';

const page = (over: Partial<Parameters<typeof checkPage>[0]> = {}) => ({ title: 'Q4 launch', summary: '', body: '', related: [], ...over });
const codeOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof MemoryError ? `${error.status} ${error.code}` : 'other';
  }
};

describe('memory page caps', () => {
  test('the body cap counts UTF-8 bytes, not characters', () => {
    // "é" is 2 bytes: 4,096 of them are 8,192 bytes, one more is over.
    expect(codeOf(() => checkPage(page({ body: 'é'.repeat(4096) })))).toBeNull();
    expect(codeOf(() => checkPage(page({ body: 'é'.repeat(4096) + 'a' })))).toBe('413 page_too_large');
    expect(codeOf(() => checkPage(page({ body: 'a'.repeat(8193) })))).toBe('413 page_too_large');
  });

  test('title 1 to 120 characters, summary one line of at most 200, at most 10 related', () => {
    expect(codeOf(() => checkPage(page({ title: 'x'.repeat(120) })))).toBeNull();
    expect(codeOf(() => checkPage(page({ title: 'x'.repeat(121) })))).toBe('400 invalid_input');
    expect(codeOf(() => checkPage(page({ title: '   ' })))).toBe('400 invalid_input');
    expect(codeOf(() => checkPage(page({ summary: 's'.repeat(200) })))).toBeNull();
    expect(codeOf(() => checkPage(page({ summary: 's'.repeat(201) })))).toBe('400 invalid_input');
    expect(codeOf(() => checkPage(page({ summary: 'two\nlines' })))).toBe('400 invalid_input');
    const ids = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(codeOf(() => checkPage(page({ related: ids.slice(0, 10) })))).toBeNull();
    expect(codeOf(() => checkPage(page({ related: ids })))).toBe('400 invalid_input');
  });

  test('a secret anywhere in the page is 422', () => {
    expect(codeOf(() => checkPage(page({ body: 'key sk-abcdefghijklmnopqrst' })))).toBe('422 secret_detected');
  });

  test('title keys ignore case, outer and repeated whitespace, and width variants', () => {
    expect(titleKey('  Q4  Launch')).toBe('q4 launch');
    expect(titleKey('Ｑ４ launch')).toBe('q4 launch');
  });
});
