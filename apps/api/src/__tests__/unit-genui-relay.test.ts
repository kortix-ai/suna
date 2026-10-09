import { describe, expect, test } from 'bun:test';

import { relayAnswerText } from '../projects/routes/turn-stream-handlers';

describe('relayAnswerText', () => {
  test('converts openui blocks to markdown before Slack/Teams formatting', () => {
    const text = relayAnswerText('Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```\n');
    expect(text).toBe('Done.\n\n[shipped]');
  });
  test('plain text is trimmed and otherwise unchanged', () => {
    expect(relayAnswerText('  hello  ')).toBe('hello');
    expect(relayAnswerText(undefined)).toBe('');
  });
});
