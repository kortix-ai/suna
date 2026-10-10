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

  const CUT = 'Here.\n\n```openui\nroot = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfin';
  const message = (info: Record<string, unknown>) =>
    ({ info: { id: 'm1', role: 'assistant', ...info }, parts: [{ id: 'p1', type: 'text', text: CUT }] }) as unknown as Parameters<
      typeof extractMessageText
    >[0];

  test('a message still streaming never prints the cut-off note', () => {
    expect(extractMessageText(message({ time: { created: 1 } }))).toBe('Here.\n\n[kept]');
  });

  test('a finished or failed message that lost its last statement says so', () => {
    expect(extractMessageText(message({ time: { created: 1, completed: 2 } }))).toBe('Here.\n\n[kept]\n\n*Response was cut off.*');
    expect(extractMessageText(message({ time: { created: 1 }, error: { name: 'Aborted' } }))).toBe(
      'Here.\n\n[kept]\n\n*Response was cut off.*',
    );
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

  test('a turn still streaming reports working, never a cut-off note', () => {
    const msgs = [
      {
        info: { id: 'a1', role: 'assistant', sessionID: 's', time: { created: 1 } },
        parts: [{ type: 'text', text: '```openui\nroot = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfin' }],
      },
    ] as unknown as Parameters<typeof deriveActivity>[0];
    expect(deriveActivity(msgs, 'running').summary).toBe('working…');
  });
});
