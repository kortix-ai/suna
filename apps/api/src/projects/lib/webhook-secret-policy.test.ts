import { describe, expect, test } from 'bun:test';
import { webhookSecretConfigurationError } from './webhook-secret-policy';

/**
 * The webhook-secret 409s must be actionable on their own: the remediation
 * names the scope problem and the exact re-store command (KRTX-1913). The CLI
 * renders this field verbatim in `surfaceApiError`, so the wording is
 * contract — a regression here is an opaque 409 again.
 */
describe('webhookSecretConfigurationError — actionable remediation', () => {
  test('delivery_mismatch names the scope problem and the exact re-store command', () => {
    const err = webhookSecretConfigurationError('delivery_mismatch', 'DOGFOOD_SECRET');
    expect(err.code).toBe('webhook_secret_delivery_mismatch');
    expect(err.remediation).toContain(
      'kortix secrets set DOGFOOD_SECRET=<value> --scope connector',
    );
  });

  test('missing and inactive name the exact create/re-store command', () => {
    const missing = webhookSecretConfigurationError('missing', 'DOGFOOD_SECRET');
    expect(missing.remediation).toContain(
      'kortix secrets set DOGFOOD_SECRET=<value> --scope connector',
    );
    const inactive = webhookSecretConfigurationError('inactive', 'DOGFOOD_SECRET');
    expect(inactive.remediation).toContain(
      'kortix secrets set DOGFOOD_SECRET=<value> --scope connector',
    );
  });

  test('without a secret name the command stays copy-pasteable', () => {
    const err = webhookSecretConfigurationError('delivery_mismatch');
    expect(err.remediation).toContain('kortix secrets set <NAME>=<value> --scope connector');
  });
});
