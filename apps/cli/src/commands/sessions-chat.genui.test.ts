import { describe, expect, test } from 'bun:test';

import { extractMessageText } from './sessions-chat';

describe('extractMessageText', () => {
  test('prints openui blocks as markdown', () => {
    const msg = {
      info: { id: 'm1', role: 'assistant' },
      parts: [{ id: 'p1', type: 'text', text: 'Here.\n\n```openui\nroot = Stack([b])\nb = Badge("ok")\n```' }],
    } as unknown as Parameters<typeof extractMessageText>[0];
    expect(extractMessageText(msg)).toBe('Here.\n\n[ok]');
  });
});
