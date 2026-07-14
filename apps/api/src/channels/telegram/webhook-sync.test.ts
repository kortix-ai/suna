import { describe, expect, test } from 'bun:test';
import { telegramWebhookResyncTarget } from './webhook-sync';

const P = 'proj-123';

describe('telegramWebhookResyncTarget', () => {
  test('builds the webhook URL for a public https base', () => {
    expect(telegramWebhookResyncTarget('https://abc.trycloudflare.com', P)).toBe(
      'https://abc.trycloudflare.com/v1/webhooks/telegram/proj-123',
    );
    expect(telegramWebhookResyncTarget('https://api.kortix.com/', P)).toBe(
      'https://api.kortix.com/v1/webhooks/telegram/proj-123',
    );
  });

  test('null when there is no usable public https origin (nothing to point at)', () => {
    expect(telegramWebhookResyncTarget(undefined, P)).toBeNull();
    expect(telegramWebhookResyncTarget('', P)).toBeNull();
    expect(telegramWebhookResyncTarget('http://localhost:8008', P)).toBeNull(); // not https
    expect(telegramWebhookResyncTarget('https://localhost:8008', P)).toBeNull(); // https-but-loopback
    expect(telegramWebhookResyncTarget('https://127.0.0.1:8008', P)).toBeNull();
  });
});
