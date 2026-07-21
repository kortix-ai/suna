/**
 * `session_mode: keyed` + `filter` — the two additions that let a plain webhook
 * trigger host a conversational source (WhatsApp, SMS, email) without any
 * channel-specific code.
 *
 * `keyed` buckets sessions by a value rendered from the payload, so one trigger
 * becomes one session per chat instead of one per fire (`fresh`) or one for
 * everything (`reuse`). `filter` drops deliveries the trigger shouldn't act on
 * — above all the agent's OWN outbound messages, which would otherwise loop it
 * against itself.
 */
import { describe, expect, test } from 'bun:test';
import { renderSessionKey, triggerFilterMatches } from '../projects/lib/trigger-payload';
import type { GitTriggerSpec } from '../projects/triggers';

function spec(overrides: Partial<GitTriggerSpec> = {}): GitTriggerSpec {
  return {
    slug: 'whatsapp',
    path: 'kortix.yaml#triggers.whatsapp',
    name: 'WhatsApp',
    type: 'webhook',
    agent: 'default',
    model: null,
    enabled: true,
    promptTemplate: '{{ body.data.text }}',
    cron: null,
    runAt: null,
    timezone: 'UTC',
    secretEnv: 'WAG_WEBHOOK_SECRET',
    sessionMode: 'fresh',
    pinnedSessionId: null,
    sessionKey: null,
    filter: null,
    ...overrides,
  };
}

const delivery = (over: Record<string, unknown> = {}) => ({
  body: {
    type: 'message.received',
    data: { chat_jid: '4917@s.whatsapp.net', direction: 'inbound', text: 'Yo', ...over },
  },
});

describe('session_mode: keyed', () => {
  test('renders the session key from the delivery payload', () => {
    const key = renderSessionKey(
      spec({ sessionMode: 'keyed', sessionKey: '{{ body.data.chat_jid }}' }),
      delivery(),
    );
    expect(key).toBe('4917@s.whatsapp.net');
  });

  test('distinct chats produce distinct keys — the whole point of keyed mode', () => {
    const s = spec({ sessionMode: 'keyed', sessionKey: '{{ body.data.chat_jid }}' });
    const a = renderSessionKey(s, delivery({ chat_jid: 'a@s.whatsapp.net' }));
    const b = renderSessionKey(s, delivery({ chat_jid: 'b@s.whatsapp.net' }));
    expect(a).not.toBe(b);
  });

  test('is inert for every other mode, so existing triggers are untouched', () => {
    for (const sessionMode of ['fresh', 'reuse', 'pinned'] as const) {
      expect(renderSessionKey(spec({ sessionMode }), delivery())).toBeNull();
    }
  });

  test('an unresolvable key degrades to fresh rather than bucketing everything together', () => {
    // A blank key would otherwise collide every keyless delivery into one shared
    // session — strictly worse than a fresh session per fire.
    const key = renderSessionKey(
      spec({ sessionMode: 'keyed', sessionKey: '{{ body.data.nonexistent }}' }),
      delivery(),
    );
    expect(key).toBeNull();
  });

  test('caps the key length so a hostile payload cannot bloat session metadata', () => {
    const key = renderSessionKey(
      spec({ sessionMode: 'keyed', sessionKey: '{{ body.data.chat_jid }}' }),
      delivery({ chat_jid: 'x'.repeat(5_000) }),
    );
    expect(key!.length).toBe(512);
  });
});

describe('trigger filter', () => {
  test('an unfiltered trigger fires on everything', () => {
    expect(triggerFilterMatches(spec(), delivery())).toBe(true);
  });

  test('breaks the reply loop: inbound fires, the agent’s own outbound does not', () => {
    const s = spec({ filter: { 'body.data.direction': 'inbound' } });
    expect(triggerFilterMatches(s, delivery({ direction: 'inbound' }))).toBe(true);
    expect(triggerFilterMatches(s, delivery({ direction: 'outbound' }))).toBe(false);
  });

  test('every clause must match', () => {
    const s = spec({
      filter: { 'body.data.direction': 'inbound', 'body.type': 'message.received' },
    });
    expect(triggerFilterMatches(s, delivery())).toBe(true);
    expect(
      triggerFilterMatches(s, { body: { type: 'chat.updated', data: { direction: 'inbound' } } }),
    ).toBe(false);
  });

  test('a missing path fails closed instead of matching', () => {
    expect(triggerFilterMatches(spec({ filter: { 'body.data.absent': 'x' } }), delivery())).toBe(
      false,
    );
  });

  test('compares stringwise, so JSON booleans and numbers behave predictably', () => {
    const payload = { body: { ok: true, count: 3 } };
    expect(triggerFilterMatches(spec({ filter: { 'body.ok': 'true' } }), payload)).toBe(true);
    expect(triggerFilterMatches(spec({ filter: { 'body.count': '3' } }), payload)).toBe(true);
    expect(triggerFilterMatches(spec({ filter: { 'body.count': '4' } }), payload)).toBe(false);
  });
});
