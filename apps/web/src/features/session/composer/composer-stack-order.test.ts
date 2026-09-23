import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The owner's rule for the stack above the composer: the reply quotes and the
// queued messages are two SEPARATE cards, and the reply card sits ABOVE the
// queue card. A merge of `main` (inline reply quotes) put the queue card on
// top with the quote card pressed under it, reading as one block (2026-09-24).
const composer = readFileSync(fileURLToPath(new URL('./composer.tsx', import.meta.url)), 'utf8');

describe('the stack above the composer', () => {
  test('the reply-quote card renders above the queued-messages card', () => {
    const quoteCard = composer.indexOf('<QuoteList');
    const queueCard = composer.indexOf('{aboveSlot && <div');
    expect(quoteCard).toBeGreaterThan(-1);
    expect(queueCard).toBeGreaterThan(-1);
    expect(quoteCard).toBeLessThan(queueCard);
  });

  test('each is its own card: the queue card never mounts inside the quote card', () => {
    const quoteWrapper = composer.slice(
      composer.lastIndexOf('<div', composer.indexOf('<QuoteList')),
      composer.indexOf('{aboveSlot && <div'),
    );
    expect(quoteWrapper).not.toContain('aboveSlot');
    expect(quoteWrapper).toContain('</div>');
  });
});
