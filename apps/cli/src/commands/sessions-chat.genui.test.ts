import { describe, expect, test } from 'bun:test';
import type { SessionLogMessage } from '@kortix/sdk';

import { deriveActivity, logMessageText } from './sessions-chat';

const reply = (text: string, over: Partial<SessionLogMessage> = {}): SessionLogMessage => ({
  schema: 'kortix.session/2', v: 1, message_id: 'm1', thread_id: 's', seq: 1, role: 'assistant', kind: 'turn', status: 'complete',
  in_context: true, model: null, usage: null, finish: null, error: null, created_at: new Date(1).toISOString(), completed_at: null,
  producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks: [{ type: 'text', id: 'b1', text }], ...over,
});

describe('logMessageText', () => {
  test('prints openui blocks as markdown', () => {
    expect(logMessageText(reply('Here.\n\n```openui\nroot = Stack([b])\nb = Badge("ok")\n```'))).toBe('Here.\n\n[ok]');
  });

  const CUT = 'Here.\n\n```openui\nroot = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfin';

  test('a message still streaming never prints the cut-off note', () => {
    expect(logMessageText(reply(CUT, { status: 'streaming' }))).toBe('Here.\n\n[kept]');
  });

  test('a finished or failed message that lost its last statement says so', () => {
    expect(logMessageText(reply(CUT))).toBe('Here.\n\n[kept]\n\n*Response was cut off.*');
    expect(logMessageText(reply(CUT, { status: 'aborted', error: { code: 'Aborted', message: 'aborted' } }))).toBe(
      'Here.\n\n[kept]\n\n*Response was cut off.*',
    );
  });
});

describe('deriveActivity', () => {
  test('the status summary shows openui blocks as markdown, never source', () => {
    const activity = deriveActivity([reply('Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```')], 'running');
    expect(activity.summary).toBe('Done. [shipped]');
  });

  test('a turn still streaming reports working, never a cut-off note', () => {
    const msgs = [reply('```openui\nroot = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfin', { status: 'streaming' })];
    expect(deriveActivity(msgs, 'running').summary).toBe('working…');
  });
});
