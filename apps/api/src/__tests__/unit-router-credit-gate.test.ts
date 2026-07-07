import { describe, expect, test } from 'bun:test';
import { creditGateExemptEnv } from '../router/services/credit-gate-env';

// dev/preview QA exemption from the router credit gate — mirrors
// accountIsFreeTierForModels' env carve-out (see unit-tier-model-entitlement).
// Regression: web_search 402'd "Insufficient credits" for every fresh dev
// account because billing internal is intentionally enabled on dev.
describe('creditGateExemptEnv', () => {
  test('dev and preview are exempt from the internal credit gate', () => {
    expect(creditGateExemptEnv('dev')).toBe(true);
    expect(creditGateExemptEnv('preview')).toBe(true);
  });

  test('prod and staging keep the real credit gate', () => {
    expect(creditGateExemptEnv('prod')).toBe(false);
    expect(creditGateExemptEnv('staging')).toBe(false);
  });

  test('no-arg form matches the explicit call for the ambient env', () => {
    const ambient = process.env.INTERNAL_KORTIX_ENV || 'dev';
    expect(creditGateExemptEnv()).toBe(creditGateExemptEnv(ambient));
  });
});
