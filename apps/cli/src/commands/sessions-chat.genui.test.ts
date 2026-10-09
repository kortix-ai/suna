import { describe, expect, test } from 'bun:test';

import { deriveActivity, extractMessageText } from './sessions-chat';

describe('extractMessageText', () => {
  test('prints openui blocks as markdown', () => {
    const msg = {
      info: { id: 'm1', role: 'assistant' },
      parts: [{ id: 'p1', type: 'text', text: 'Here.\n\n```openui\nroot = Stack([b])\nb = Badge("ok")\n```' }],
    } as unknown as Parameters<typeof extractMessageText>[0];
    expect(extractMessageText(msg)).toBe('Here.\n\n[ok]');
  });
});

describe('deriveActivity', () => {
  test('the status summary shows openui blocks as markdown, never source', () => {
    const msgs = [
      {
        info: { id: 'a1', role: 'assistant', sessionID: 's', time: { created: 1, completed: 2 } },
        parts: [{ type: 'text', text: 'Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```' }],
      },
    ] as unknown as Parameters<typeof deriveActivity>[0];
    const activity = deriveActivity(msgs, 'running');
    expect(activity.summary).toBe('Done. [shipped]');
  });
});
