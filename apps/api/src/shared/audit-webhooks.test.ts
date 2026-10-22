import { describe, expect, test } from 'bun:test';
import { auditWebhookFailureSummary } from './audit-webhook-privacy';
import { entitlementLookupFailure } from './audit-webhooks';

describe('audit webhook failure privacy', () => {
  test('fingerprints receiver response bodies without retaining their content', () => {
    const raw = 'token=private-response-token';
    const summary = auditWebhookFailureSummary('http', raw, 503);

    expect(summary).toMatch(/^HTTP 503; response_sha256=[0-9a-f]{64}$/);
    expect(summary).not.toContain(raw);
    expect(summary).not.toContain('private-response-token');
  });

  test('fingerprints network and SSRF errors without retaining configured URLs', () => {
    const raw = 'fetch failed for https://user:secret@example.test/private?token=hidden';

    for (const kind of ['network', 'blocked'] as const) {
      const summary = auditWebhookFailureSummary(kind, raw);
      expect(summary).toMatch(new RegExp(`^${kind}_error; error_sha256=[0-9a-f]{64}$`));
      expect(summary).not.toContain('example.test');
      expect(summary).not.toContain('secret');
    }
  });
});

describe('entitlement lookup failure', () => {
  test('retries with backoff instead of dead-lettering on the first error', () => {
    const update = entitlementLookupFailure(1, 'pool timeout', 1_000_000);
    expect(update.status).toBe('retry');
    expect(update.attempts).toBe(1);
    expect(update.nextAttemptAt.getTime()).toBeGreaterThan(1_000_000);
    expect(update.lastError).toBe('entitlement lookup failed: pool timeout');
    expect(update.lockedBy).toBeNull();
  });

  test('dead-letters at the attempt cap', () => {
    expect(entitlementLookupFailure(8, 'pool timeout').status).toBe('dead_letter');
  });
});
