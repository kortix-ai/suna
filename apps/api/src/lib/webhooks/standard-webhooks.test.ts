import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import {
  decodeSecrets,
  readStandardWebhookHeaders,
  verifyStandardWebhook,
} from './standard-webhooks';

const SECRET_BYTES = Buffer.from('a'.repeat(32));
const BASE64 = SECRET_BYTES.toString('base64');
const NOW = 1_700_000_000_000;

function sign(rawBody: string, id: string, timestamp: string, key = SECRET_BYTES): string {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

describe('verifyStandardWebhook', () => {
  const rawBody = '{"user":{"email":"a@b.test"}}';
  const id = 'msg_1';
  const timestamp = String(Math.floor(NOW / 1000));

  test('accepts a valid signature under every secret encoding', () => {
    // Supabase writes `v1,whsec_<base64>`; Svix senders use `whsec_<base64>`.
    for (const secret of [BASE64, `whsec_${BASE64}`, `v1,whsec_${BASE64}`]) {
      expect(
        verifyStandardWebhook({
          rawBody,
          secret,
          headers: { id, timestamp, signature: sign(rawBody, id, timestamp) },
          now: NOW,
        }),
      ).toBe(true);
    }
  });

  test('rejects a tampered body, a wrong key, and a missing signature', () => {
    const headers = { id, timestamp, signature: sign(rawBody, id, timestamp) };
    expect(verifyStandardWebhook({ rawBody: `${rawBody} `, secret: BASE64, headers, now: NOW })).toBe(false);
    expect(
      verifyStandardWebhook({
        rawBody,
        secret: Buffer.from('b'.repeat(32)).toString('base64'),
        headers,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifyStandardWebhook({ rawBody, secret: BASE64, headers: { id, timestamp, signature: '' }, now: NOW }),
    ).toBe(false);
  });

  test('rejects a replay outside the timestamp tolerance', () => {
    const old = String(Math.floor(NOW / 1000) - 600);
    expect(
      verifyStandardWebhook({
        rawBody,
        secret: BASE64,
        headers: { id, timestamp: old, signature: sign(rawBody, id, old) },
        now: NOW,
      }),
    ).toBe(false);
  });

  test('accepts either secret while one is being rotated', () => {
    const next = Buffer.from('c'.repeat(32));
    expect(
      verifyStandardWebhook({
        rawBody,
        secret: `v1,whsec_${BASE64} v1,whsec_${next.toString('base64')}`,
        headers: { id, timestamp, signature: sign(rawBody, id, timestamp, next) },
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe('decodeSecrets', () => {
  test('ignores empty and undecodable entries', () => {
    expect(decodeSecrets('')).toEqual([]);
    expect(decodeSecrets(`v1,whsec_${BASE64}`)).toHaveLength(1);
  });
});

describe('readStandardWebhookHeaders', () => {
  test('prefers standard names and falls back to the legacy svix-* ones', () => {
    expect(
      readStandardWebhookHeaders((name) => (name === 'svix-id' ? 'legacy' : undefined)),
    ).toEqual({ id: 'legacy', timestamp: '', signature: '' });
    expect(
      readStandardWebhookHeaders((name) =>
        name === 'webhook-id' ? 'standard' : name === 'svix-id' ? 'legacy' : undefined,
      ).id,
    ).toBe('standard');
  });
});
