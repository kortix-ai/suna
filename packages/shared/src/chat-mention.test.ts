import { describe, expect, test } from 'bun:test';

import { stripChatMentionMarkup } from './chat-mention';

describe('stripChatMentionMarkup', () => {
  test('removes a Teams mention, with or without attributes, and collapses the whitespace', () => {
    expect(stripChatMentionMarkup('<at>Kortix Dev</at>&nbsp; now count   the lines')).toBe('now count the lines');
    expect(stripChatMentionMarkup('hi <AT id="0">Kortix</AT> there')).toBe('hi there');
    expect(stripChatMentionMarkup('plain')).toBe('plain');
  });

  test('leaves a tag that only starts with "at" alone', () => {
    expect(stripChatMentionMarkup('see <attachment>file</attachment>')).toBe('see <attachment>file</attachment>');
  });

  test('stays linear on many unclosed "<at" openers (CodeQL js/polynomial-redos)', () => {
    const hostile = '<at'.repeat(50_000);
    const started = performance.now();
    expect(stripChatMentionMarkup(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
