import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  verifyWebhookSignature,
  webhookTimestampFresh,
} from './trigger-webhook-auth';

// KRTX-4098 (CWE-294): a captured signed delivery replayed forever, because the
// HMAC covered the body alone. The signature now covers `<timestamp>.<body>` and
// the timestamp is required and fresh, so a captured delivery stops verifying.
const secret = 'synthetic-secret';
const body = '{"event":"deploy.succeeded"}';
const now = 1_700_000_000_000;
const at = Math.floor(now / 1000);
const sign = (payload: string) =>
  `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

describe('webhook timestamp (KRTX-4098)', () => {
  test('accepts a fresh timestamp whose signature covers it', () => {
    expect(verifyWebhookSignature(body, String(at), secret, sign(`${at}.${body}`), now)).toBe(true);
  });

  test('refuses a missing or blank timestamp, so no unsigned-body signature can verify', () => {
    expect(verifyWebhookSignature(body, null, secret, sign(body), now)).toBe(false);
    expect(verifyWebhookSignature(body, '  ', secret, sign(`  .${body}`), now)).toBe(false);
  });

  test('a captured signature stops verifying once its timestamp ages out', () => {
    const captured = sign(`${at}.${body}`);
    const inside = now + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS * 1000;
    const outside = inside + 1000;
    expect(verifyWebhookSignature(body, String(at), secret, captured, inside)).toBe(true);
    expect(verifyWebhookSignature(body, String(at), secret, captured, outside)).toBe(false);
  });

  test('a fresh timestamp cannot revive a captured signature: the signature covers the timestamp', () => {
    const captured = sign(`${at}.${body}`);
    expect(verifyWebhookSignature(body, String(at + 1), secret, captured, now)).toBe(false);
  });

  test('rejects a future timestamp beyond the tolerance', () => {
    expect(
      verifyWebhookSignature(body, String(at + 1), secret, sign(`${at + 1}.${body}`), now),
    ).toBe(true);
    expect(
      verifyWebhookSignature(body, String(at + 301), secret, sign(`${at + 301}.${body}`), now),
    ).toBe(false);
  });

  test('webhookTimestampFresh parses epoch seconds and refuses non-numbers', () => {
    expect(webhookTimestampFresh(String(at), now)).toBe(true);
    expect(webhookTimestampFresh(String(at - 300), now)).toBe(true);
    expect(webhookTimestampFresh(String(at - 301), now)).toBe(false);
    expect(webhookTimestampFresh('not-a-number', now)).toBe(false);
    expect(webhookTimestampFresh(null, now)).toBe(false);
  });
});
