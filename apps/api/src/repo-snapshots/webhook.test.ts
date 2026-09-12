import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { verifyGitHubWebhookSignature } from './webhook';

const SECRET = 'whsec_example_only_not_a_real_secret';
const BODY = JSON.stringify({ ref: 'refs/heads/main', repository: { id: 1296269 } });

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGitHubWebhookSignature', () => {
  test('accepts a correct signature, with or without the sha256= prefix', () => {
    expect(verifyGitHubWebhookSignature(BODY, sign(BODY, SECRET), [SECRET])).toBe(true);
    expect(verifyGitHubWebhookSignature(BODY, sign(BODY, SECRET).slice(7), [SECRET])).toBe(true);
  });

  test('accepts any configured secret, so a rotation does not drop deliveries', () => {
    expect(verifyGitHubWebhookSignature(BODY, sign(BODY, 'next'), ['previous', 'next'])).toBe(true);
  });

  test('rejects a wrong secret, a tampered body and a malformed header', () => {
    expect(verifyGitHubWebhookSignature(BODY, sign(BODY, 'wrong'), [SECRET])).toBe(false);
    expect(verifyGitHubWebhookSignature(`${BODY} `, sign(BODY, SECRET), [SECRET])).toBe(false);
    expect(verifyGitHubWebhookSignature(BODY, 'sha256=zz', [SECRET])).toBe(false);
    expect(verifyGitHubWebhookSignature(BODY, 'sha1=' + 'a'.repeat(40), [SECRET])).toBe(false);
    expect(verifyGitHubWebhookSignature(BODY, null, [SECRET])).toBe(false);
  });

  test('rejects EVERYTHING when no secret is configured', () => {
    // An unconfigured deployment must not accept unauthenticated deliveries.
    expect(verifyGitHubWebhookSignature(BODY, sign(BODY, SECRET), [])).toBe(false);
    expect(verifyGitHubWebhookSignature(BODY, null, [])).toBe(false);
  });
});
