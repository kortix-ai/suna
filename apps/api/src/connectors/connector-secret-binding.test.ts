import { describe, expect, test } from 'bun:test';
import { validateConnectorSecretBinding } from './connector-secret-binding';

const valid = {
  secretIdentifier: 'API_KEY',
  requiresAuth: true,
  provider: 'openapi',
  authorizationStrategy: 'project' as const,
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

  test('rejects platform, user-owned, stored, and incompatible credential sources', () => {
    expect(validateConnectorSecretBinding({ ...valid, provider: 'channel' })?.error).toContain(
      'does not accept',
    );
    expect(
      validateConnectorSecretBinding({ ...valid, authorizationStrategy: 'user' })?.error,
    ).toContain('project authorization');
    expect(
      validateConnectorSecretBinding({ ...valid, hasStoredCredential: true })?.error,
    ).toContain('Disconnect');
    expect(validateConnectorSecretBinding({ ...valid, secretCompatible: false })?.error).toContain(
      'active',
    );
  });
});
