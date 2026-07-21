import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { asMessageData, type WhatsAppGatewayEvent } from '../channels/whatsapp/types';
import { verifyWhatsAppSignature } from '../channels/whatsapp/verify';

const SECRET = 'whsec_test_secret_value';

function sign(rawBody: string, timestamp: string, secret = SECRET): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function messageEvent(overrides: Partial<Record<string, unknown>> = {}): WhatsAppGatewayEvent {
  return {
    id: 'evt_1',
    tenant_id: 'ten_1',
    account_id: 'wa_1',
    sequence: 1,
    type: 'message.created',
    occurred_at: new Date().toISOString(),
    data: {
      id: 'msg_1',
      whatsapp_message_id: 'WA1',
      chat_jid: '4917600000000@s.whatsapp.net',
      sender_jid: '4917600000000@s.whatsapp.net',
      direction: 'inbound',
      type: 'conversation',
      text: 'hey',
      timestamp: new Date().toISOString(),
      ...overrides,
    },
  };
}

describe('whatsapp gateway signature verification', () => {
  test('accepts a correctly signed body', () => {
    const body = JSON.stringify(messageEvent());
    const timestamp = nowSeconds();
    expect(
      verifyWhatsAppSignature({
        rawBody: body,
        secret: SECRET,
        timestamp,
        signature: sign(body, timestamp),
      }),
    ).toBe(true);
  });

  test('rejects a tampered body', () => {
    const timestamp = nowSeconds();
    const signature = sign(JSON.stringify(messageEvent()), timestamp);
    expect(
      verifyWhatsAppSignature({
        rawBody: JSON.stringify(messageEvent({ text: 'tampered' })),
        secret: SECRET,
        timestamp,
        signature,
      }),
    ).toBe(false);
  });

  test('rejects the wrong secret', () => {
    const body = JSON.stringify(messageEvent());
    const timestamp = nowSeconds();
    expect(
      verifyWhatsAppSignature({
        rawBody: body,
        secret: 'whsec_other',
        timestamp,
        signature: sign(body, timestamp),
      }),
    ).toBe(false);
  });

  test('rejects a replayed timestamp outside the window', () => {
    const body = JSON.stringify(messageEvent());
    const stale = String(Math.floor(Date.now() / 1000) - 6 * 60);
    expect(
      verifyWhatsAppSignature({
        rawBody: body,
        secret: SECRET,
        timestamp: stale,
        signature: sign(body, stale),
      }),
    ).toBe(false);
  });

  test('rejects a malformed signature header', () => {
    const body = JSON.stringify(messageEvent());
    const timestamp = nowSeconds();
    for (const signature of ['', 'garbage', 'v2=abc']) {
      expect(
        verifyWhatsAppSignature({ rawBody: body, secret: SECRET, timestamp, signature }),
      ).toBe(false);
    }
  });
});

describe('whatsapp message payload parsing', () => {
  test('parses an inbound message', () => {
    const parsed = asMessageData(messageEvent());
    expect(parsed?.chat_jid).toBe('4917600000000@s.whatsapp.net');
    expect(parsed?.direction).toBe('inbound');
    expect(parsed?.text).toBe('hey');
  });

  test('marks outbound messages so they never spawn a turn', () => {
    // The gateway emits message.created for both directions; echoing our own
    // sends back into the session would loop the agent against itself.
    const parsed = asMessageData(messageEvent({ direction: 'outbound' }));
    expect(parsed?.direction).toBe('outbound');
  });

  test('returns null for a payload without a chat', () => {
    const event = messageEvent();
    event.data = { id: 'msg_1' };
    expect(asMessageData(event)).toBeNull();
  });
});
