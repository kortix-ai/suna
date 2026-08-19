import { describe, expect, test } from 'bun:test';

import { connectorSecretBindingInput } from './connectors.ts';

describe('connectorSecretBindingInput', () => {
  test('binds an identifier to a connector slug', () => {
    expect(connectorSecretBindingInput(['github', 'GITHUB_API_KEY'], false)).toEqual({
      slug: 'github',
      secretIdentifier: 'GITHUB_API_KEY',
    });
  });

  test('clears a connector binding without an identifier', () => {
    expect(connectorSecretBindingInput(['github'], true)).toEqual({
      slug: 'github',
      secretIdentifier: null,
    });
  });

  test('rejects missing and ambiguous arguments', () => {
    expect(connectorSecretBindingInput([], false)).toEqual({ error: 'a connector slug' });
    expect(connectorSecretBindingInput(['github'], false)).toEqual({
      error: 'a secret identifier',
    });
    expect(connectorSecretBindingInput(['github', 'GITHUB_API_KEY'], true)).toEqual({
      error: 'Do not pass a secret identifier with --clear.',
    });
  });
});
