import { describe, expect, test } from 'bun:test';
import type { ResolvedProjectSecret } from '../projects/secrets';
import { resolveAppRuntimeEnvironment } from './environment';

function secret(identifier: string, key: string, value: string): ResolvedProjectSecret {
  return {
    secretId: `secret-${identifier}`,
    identifier,
    key,
    value,
  };
}

describe('resolveAppRuntimeEnvironment', () => {
  test('merges literal values and identifier-mapped project secrets', () => {
    expect(resolveAppRuntimeEnvironment({
      environment: { NODE_ENVIRONMENT: 'production' },
      secrets: { DATABASE_URL: 'database-primary' },
      availableSecrets: [secret('database-primary', 'INTERNAL_DATABASE_URL', 'postgres://private')],
    })).toEqual({
      env: {
        NODE_ENVIRONMENT: 'production',
        DATABASE_URL: 'postgres://private',
      },
      secretIdentifiers: ['database-primary'],
    });
  });

  test('rejects missing secrets without exposing any available value', () => {
    expect(() => resolveAppRuntimeEnvironment({
      environment: {},
      secrets: { DATABASE_URL: 'missing' },
      availableSecrets: [secret('present', 'DATABASE_URL', 'do-not-print')],
    })).toThrow('App secret identifier "missing" does not exist');
  });

  test('rejects reserved keys and duplicate literal/secret destinations', () => {
    expect(() => resolveAppRuntimeEnvironment({
      environment: { KORTIX_APPD_TOKEN: 'bad' },
      secrets: {},
      availableSecrets: [],
    })).toThrow('reserved');
    expect(() => resolveAppRuntimeEnvironment({
      environment: { DATABASE_URL: 'literal' },
      secrets: { DATABASE_URL: 'database-primary' },
      availableSecrets: [secret('database-primary', 'DATABASE_URL', 'secret')],
    })).toThrow('both environment and secrets');
  });

  test('rejects non-runtime delivery strategies', () => {
    expect(() => resolveAppRuntimeEnvironment({
      environment: {},
      secrets: { TOKEN: 'brokered-token' },
      availableSecrets: [{
        ...secret('brokered-token', 'TOKEN', 'private'),
        strategy: 'broker',
      }],
    })).toThrow('cannot be delivered to an App runtime');
  });
});
