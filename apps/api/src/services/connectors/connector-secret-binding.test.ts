import { describe, expect, test } from 'bun:test';
import { validateConnectorSecretBinding } from './connector-secret-binding';

const valid = {
  secretIdentifier: 'API_KEY',
  requiresAuth: true,
  provider: 'openapi',
  hasStoredCredential: false,
  secretCompatible: true,
};

describe('validateConnectorSecretBinding', () => {
  test('accepts one compatible project secret binding', () => {
    expect(validateConnectorSecretBinding(valid)).toBeNull();
  });

  test('always permits an explicit unbind', () => {
    expect(
      validateConnectorSecretBinding({
        ...valid,
        secretIdentifier: null,
        hasStoredCredential: true,
        secretCompatible: false,
      }),
    ).toBeNull();
  });

  // `authorizationStrategy` used to reject binding on a 'user'-strategy
  // connector — the connector-level strategy is retired (connection-access.ts),
  // so binding is decided purely on the connector's own auth shape, never on
  // who happens to own its accounts. There is no owner/strategy field left to
  // reject on.
  test('rejects platform, stored, and incompatible credential sources', () => {
    expect(validateConnectorSecretBinding({ ...valid, provider: 'channel' })?.error).toContain(
      'does not accept',
    );
    expect(
      validateConnectorSecretBinding({ ...valid, hasStoredCredential: true })?.error,
    ).toContain('Disconnect');
    expect(validateConnectorSecretBinding({ ...valid, secretCompatible: false })?.error).toContain(
      'active',
    );
  });
});
