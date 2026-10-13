import { describe, expect, test } from 'bun:test';

import { isTextEntry } from './text-entry';

const el = (tagName: string, extra: object = {}) => ({ tagName, ...extra }) as unknown as EventTarget;

describe('isTextEntry', () => {
  test('inputs, textareas and contenteditable take Escape themselves', () => {
    expect(isTextEntry(el('INPUT'))).toBe(true);
    expect(isTextEntry(el('TEXTAREA'))).toBe(true);
    expect(isTextEntry(el('DIV', { isContentEditable: true }))).toBe(true);
  });
  test('buttons, the document and null do not', () => {
    expect(isTextEntry(el('BUTTON'))).toBe(false);
    expect(isTextEntry(el('DIV', { isContentEditable: false }))).toBe(false);
    expect(isTextEntry({} as EventTarget)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
