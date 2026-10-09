import { describe, expect, test } from 'bun:test';

import { relayAnswerText, relayTextRejection } from '../projects/routes/turn-stream-handlers';

describe('relayAnswerText', () => {
  test('converts openui blocks to markdown before Slack/Teams formatting', () => {
    const text = relayAnswerText('Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```\n');
    expect(text).toBe('Done.\n\n[shipped]');
  });
  test('plain text is trimmed and otherwise unchanged', () => {
    expect(relayAnswerText('  hello  ')).toBe('hello');
    expect(relayAnswerText(undefined)).toBe('');
  });
  test('an ordinary code fence passes through unchanged', () => {
    const code = 'Run this:\n\n```ts\nconst x = 1;\n```';
    expect(relayAnswerText(`  ${code}\n`)).toBe(code);
  });
});

describe('relayTextRejection', () => {
  test('missing or blank text is rejected with the existing error', () => {
    expect(relayTextRejection(undefined, '')).toEqual({ error: 'text is required' });
    expect(relayTextRejection('   ', '')).toEqual({ error: 'text is required' });
  });
  test('a block-only answer that renders to nothing is rejected, never relayed raw', () => {
    const raw = '```openui\nroot = Stack([missing])\n```';
    const text = relayAnswerText(raw);
    expect(text).toBe('');
    expect(relayTextRejection(raw, text)).toEqual({
      error: 'text is required',
      reason: 'genui_block_unrenderable',
    });
  });
  test('relayable text is not rejected', () => {
    expect(relayTextRejection('hello', 'hello')).toBeNull();
  });
});
