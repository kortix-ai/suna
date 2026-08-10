import { describe, expect, test } from 'bun:test';

import {
  networkBoundaryPolicyError,
  resolveNetworkBoundaryBindings,
} from './network-boundary';
import type { ResolvedWorkspaceSecret } from '../workspaces/secrets';

function secret(
  extra: Partial<ResolvedWorkspaceSecret> = {},
): ResolvedWorkspaceSecret {
  return {
    secretId: 'primary',
    identifier: 'billing-api',
    key: 'BILLING_API_KEY',
    value: 'test-secret-value',
    strategy: 'egress',
    consumer: 'network',
    egressPolicy: {
      rules: [{ host: 'api.example.com' }],
      inject: {
        kind: 'header',
        name: 'authorization',
        template: 'Bearer {{secret}}',
      },
      on_no_match: 'deny',
    },
    ...extra,
  };
}

describe('networkBoundaryPolicyError', () => {
  test('accepts exact hosts with one common header transform', () => {
    expect(networkBoundaryPolicyError(secret().egressPolicy!)).toBeNull();
  });

  test.each<[string, NonNullable<ResolvedWorkspaceSecret['egressPolicy']>]>([
    [
      'wildcard host',
      { ...secret().egressPolicy!, rules: [{ host: '*.example.com' }] },
    ],
    [
      'method filter',
      { ...secret().egressPolicy!, rules: [{ host: 'api.example.com', methods: ['POST'] }] },
    ],
    [
      'path filter',
      { ...secret().egressPolicy!, rules: [{ host: 'api.example.com', path: '/v1/*' }] },
    ],
    [
      'query injection',
      { ...secret().egressPolicy!, inject: { kind: 'query', name: 'token' } },
    ],
  ])('rejects %s because the provider cannot enforce it', (_name, policy) => {
    expect(networkBoundaryPolicyError(policy)).not.toBeNull();
  });

  test('rejects per-host transforms that disagree', () => {
    const row = secret({
      egressPolicy: {
        rules: [
          { host: 'api.example.com' },
          {
            host: 'uploads.example.com',
            inject: { kind: 'header', name: 'x-api-key' },
          },
        ],
        inject: { kind: 'header', name: 'authorization' },
      },
    });

    expect(networkBoundaryPolicyError(row.egressPolicy!)).toContain('same header');
  });
});

describe('resolveNetworkBoundaryBindings', () => {
  test('renders the header value and never emits an environment placeholder', () => {
    const result = resolveNetworkBoundaryBindings([secret()], {
      sessionId: 'session-1',
      agentGrantEnv: ['billing-api'],
      sessionAllowlist: ['billing-api'],
    });

    expect(result).toEqual([
      {
        secretId: 'primary',
        identifier: 'billing-api',
        alias: 'KORTIX_primary',
        hosts: ['api.example.com'],
        header: 'authorization',
        value: 'Bearer test-secret-value',
        onEcho: 'block',
      },
    ]);
  });

  test('withholds a boundary secret from an implicit all grant', () => {
    expect(
      resolveNetworkBoundaryBindings([secret()], {
        sessionId: 'session-1',
        agentGrantEnv: 'all',
        sessionAllowlist: null,
      }),
    ).toEqual([]);
  });

  test('withholds a boundary secret excluded by the session allowlist', () => {
    expect(
      resolveNetworkBoundaryBindings([secret()], {
        sessionId: 'session-1',
        agentGrantEnv: ['billing-api'],
        sessionAllowlist: [],
      }),
    ).toEqual([]);
  });

  test('fails closed when two secrets target the same host and header', () => {
    expect(() =>
      resolveNetworkBoundaryBindings(
        [
          secret(),
          secret({
            secretId: 'backup',
            identifier: 'billing-backup',
            key: 'BILLING_BACKUP_KEY',
          }),
        ],
        {
          sessionId: 'session-1',
          agentGrantEnv: ['billing-api', 'billing-backup'],
          sessionAllowlist: null,
        },
      ),
    ).toThrow('api.example.com');
  });
});
