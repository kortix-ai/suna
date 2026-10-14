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
  test('converts blocks inside a blockquote or a list item, never relays their source', () => {
    const block = '```openui\nroot = Stack([b])\nb = Badge("shipped")\n```';
    const quoted = block.split('\n').map((line) => `> ${line}`).join('\n');
    expect(relayAnswerText(`Done.\n\n${quoted}`)).toBe('Done.\n\n> [shipped]');
    const listed = block.split('\n').map((line) => `    ${line}`).join('\n');
    const text = relayAnswerText(`Steps:\n\n1. First\n   - Nested\n\n${listed}`);
    expect(text).toBe('Steps:\n\n1. First\n   - Nested\n\n    [shipped]');
    expect(text).not.toContain('root =');
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
  test('a settled block-only answer that cannot render relays the one-line note, never the raw source', () => {
    // The SDK renders a settled block with no valid root as the unavailable note on every
    // non-UI surface (packages/sdk/src/genui/markdown.ts), so the note is what Slack and
    // Teams get. `genui_block_unrenderable` stays the guard for a conversion that yields ''.
    const raw = '```openui\nroot = Stack([missing])\n```';
    const text = relayAnswerText(raw);
    expect(text).toBe('*This content could not be displayed.*');
    expect(text).not.toContain('root =');
    expect(relayTextRejection(raw, text)).toBeNull();
  });
  test('a block whose conversion yields nothing is rejected, never relayed raw', () => {
    // A settled block always renders the note or content; '' means the conversion failed,
    // and the refusal keeps the raw OpenUI source off Slack and Teams.
    expect(relayTextRejection('```openui\nroot = Stack([b])\nb = Badge("x")\n```', '')).toEqual({
      error: 'text is required',
      reason: 'genui_block_unrenderable',
    });
  });
  test('relayable text is not rejected', () => {
    expect(relayTextRejection('hello', 'hello')).toBeNull();
  });
});
