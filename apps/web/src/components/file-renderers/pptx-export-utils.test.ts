import { describe, expect, test } from 'bun:test';
import { resolvePptxFileName } from './pptx-export-utils';

describe('resolvePptxFileName', () => {
  test('keeps an existing .pptx extension', () => {
    expect(resolvePptxFileName('Consulting proposal.pptx')).toBe('Consulting proposal.pptx');
  });

  test('treats the extension case-insensitively', () => {
    expect(resolvePptxFileName('Deck.PPTX')).toBe('Deck.PPTX');
  });

  test('appends .pptx when it is missing', () => {
    expect(resolvePptxFileName('Consulting proposal')).toBe('Consulting proposal.pptx');
  });
});
