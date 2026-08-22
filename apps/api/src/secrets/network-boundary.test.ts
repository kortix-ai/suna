import { describe, expect, test } from 'bun:test';

import {
  findBoundaryDestinationConflict,
  networkBoundaryPolicyError,
  resolveNetworkBoundaryBindings,
} from './network-boundary';
import type { ResolvedProjectSecret } from '../projects/secrets';

function secret(
  extra: Partial<ResolvedProjectSecret> = {},
): ResolvedProjectSecret {
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
  test('accepts exact hosts with one common header transform (legacy inject row)', () => {
    expect(networkBoundaryPolicyError(secret().egressPolicy!)).toBeNull();
  });

  // The default shape since docs/specs/2026-08-19-secrets-exposure-usage-model.md
  // §6: the policy is a HOST LIST and the credential is substituted for a handle
  // wherever the agent's own client put it. There is no slot to have an opinion
  // about, so the header/template/method/path prohibitions do not apply.
  test('accepts a substitution-only policy that names no injection slot', () => {
    expect(
      networkBoundaryPolicyError({
        rules: [{ host: 'api.example.com' }, { host: 'uploads.example.com' }],
        on_no_match: 'deny',
      }),
    ).toBeNull();
  });

  test('a substitution-only policy may filter methods and paths', () => {
    expect(
      networkBoundaryPolicyError({
        rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
        on_no_match: 'deny',
      }),
    ).toBeNull();
  });

  test.each<[string, NonNullable<ResolvedProjectSecret['egressPolicy']>]>([
    ['wildcard host', { rules: [{ host: '*.example.com' }], on_no_match: 'deny' }],
    ['observe on no match', { rules: [{ host: 'api.example.com' }], on_no_match: 'observe' }],
    ['tunnelled TLS', { rules: [{ host: 'api.example.com' }], tls: 'tunnel' }],
    ['a broker backend', { rules: [{ host: 'api.example.com' }], backend: 'kortix_fetch' }],
  ])('a substitution-only policy is still refused for %s', (_name, policy) => {
    expect(networkBoundaryPolicyError(policy)).not.toBeNull();
  });

  test('a rule-level slot with no policy-level default is refused', () => {
    // "First match wins, no match denies" only names a destination if the
    // policy has one; a rule that injects alone has nothing to agree with.
    expect(
      networkBoundaryPolicyError({
        rules: [{ host: 'api.example.com', inject: { kind: 'header', name: 'authorization' } }],
        on_no_match: 'deny',
      }),
    ).toContain('policy-level slot');
  });

  test.each<[string, NonNullable<ResolvedProjectSecret['egressPolicy']>]>([
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
  test('carries policy only — never the credential', () => {
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
      },
    ]);
    // The value is fetched by the broker route per request. It used to be
    // rendered into the binding for the Platinum edge; that edge is gone, so a
    // binding that still carried it would be credential material passed around
    // and logged for no reason.
    expect(JSON.stringify(result)).not.toContain('test-secret-value');
  });

  test('a substitution-only row binds its hosts and claims no header', () => {
    const result = resolveNetworkBoundaryBindings(
      [secret({ egressPolicy: { rules: [{ host: 'API.Example.com' }], on_no_match: 'deny' } })],
      { sessionId: 'session-1', agentGrantEnv: ['billing-api'], sessionAllowlist: null },
    );

    expect(result).toEqual([
      {
        secretId: 'primary',
        identifier: 'billing-api',
        alias: 'KORTIX_primary',
        hosts: ['api.example.com'],
      },
    ]);
  });

  test('two substitution-only rows may share one host — each handle names its own value', () => {
    const hostsOnly = { rules: [{ host: 'api.example.com' }], on_no_match: 'deny' as const };
    const result = resolveNetworkBoundaryBindings(
      [
        secret({ egressPolicy: hostsOnly }),
        secret({
          secretId: 'backup',
          identifier: 'billing-backup',
          key: 'BILLING_BACKUP_KEY',
          egressPolicy: hostsOnly,
        }),
      ],
      {
        sessionId: 'session-1',
        agentGrantEnv: ['billing-api', 'billing-backup'],
        sessionAllowlist: null,
      },
    );

    expect(result.map((binding) => binding.identifier)).toEqual(['billing-api', 'billing-backup']);
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

function policy(
  hosts: string[],
  header: string,
): NonNullable<ResolvedProjectSecret['egressPolicy']> {
  return {
    rules: hosts.map((host) => ({ host })),
    inject: { kind: 'header', name: header, template: 'Bearer {{secret}}' },
    on_no_match: 'deny',
  };
}

describe('findBoundaryDestinationConflict', () => {
  test('reports the secret that already claims the same host and header', () => {
    expect(
      findBoundaryDestinationConflict(
        { identifier: 'billing-backup', policy: policy(['api.example.com'], 'authorization') },
        [{ identifier: 'billing-api', policy: policy(['api.example.com'], 'authorization') }],
      ),
    ).toEqual({
      identifier: 'billing-api',
      host: 'api.example.com',
      header: 'authorization',
    });
  });

  test('allows one host to carry two secrets under different headers', () => {
    expect(
      findBoundaryDestinationConflict(
        { identifier: 'billing-backup', policy: policy(['api.example.com'], 'x-api-key') },
        [{ identifier: 'billing-api', policy: policy(['api.example.com'], 'authorization') }],
      ),
    ).toBeNull();
  });

  test('does not collide a secret with its own stored row', () => {
    expect(
      findBoundaryDestinationConflict(
        { identifier: 'billing-api', policy: policy(['api.example.com'], 'authorization') },
        [{ identifier: 'billing-api', policy: policy(['api.example.com'], 'authorization') }],
      ),
    ).toBeNull();
  });

  test('compares host and header case-insensitively', () => {
    expect(
      findBoundaryDestinationConflict(
        { identifier: 'billing-backup', policy: policy(['API.Example.COM'], 'Authorization') },
        [{ identifier: 'billing-api', policy: policy(['api.example.com'], 'authorization') }],
      ),
    ).toEqual({
      identifier: 'billing-api',
      host: 'api.example.com',
      header: 'authorization',
    });
  });

  test('skips a secret that has no outbound policy', () => {
    expect(
      findBoundaryDestinationConflict(
        { identifier: 'billing-backup', policy: policy(['api.example.com'], 'authorization') },
        [
          { identifier: 'plain-runtime', policy: null },
          { identifier: 'billing-api', policy: policy(['other.example.com'], 'authorization') },
        ],
      ),
    ).toBeNull();
  });

  test('skips a substitution-only secret — it claims no destination at all', () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: 'billing-backup',
          policy: { rules: [{ host: 'api.example.com' }] },
        },
        [{ identifier: 'billing-api', policy: policy(['api.example.com'], 'authorization') }],
      ),
    ).toBeNull();

    // …and is not collided WITH, either. Both directions, because the check runs
    // once per save with the candidate on either side over a project's lifetime.
    expect(
      findBoundaryDestinationConflict(
        { identifier: 'billing-backup', policy: policy(['api.example.com'], 'authorization') },
        [
          {
            identifier: 'billing-api',
            policy: { rules: [{ host: 'api.example.com' }] },
          },
        ],
      ),
    ).toBeNull();
  });

  test('skips a secret injected somewhere other than a header', () => {
    expect(
      findBoundaryDestinationConflict(
        { identifier: 'billing-backup', policy: policy(['api.example.com'], 'authorization') },
        [
          {
            identifier: 'billing-api',
            policy: {
              rules: [{ host: 'api.example.com' }],
              inject: { kind: 'query', name: 'authorization' },
            },
          },
        ],
      ),
    ).toBeNull();
  });

  test('reports a conflict on any overlapping host of a multi-host policy', () => {
    expect(
      findBoundaryDestinationConflict(
        {
          identifier: 'billing-backup',
          policy: policy(['a.example.com', 'b.example.com'], 'authorization'),
        },
        [
          {
            identifier: 'billing-api',
            policy: policy(['c.example.com', 'b.example.com'], 'authorization'),
          },
        ],
      ),
    ).toEqual({
      identifier: 'billing-api',
      host: 'b.example.com',
      header: 'authorization',
    });
  });

  test('agrees with the provision-time throw on the same pair of policies', () => {
    const first = secret({ egressPolicy: policy(['API.Example.com'], 'Authorization') });
    const second = secret({
      secretId: 'backup',
      identifier: 'billing-backup',
      key: 'BILLING_BACKUP_KEY',
      egressPolicy: policy(['api.example.COM'], 'authorization'),
    });

    expect(
      findBoundaryDestinationConflict(
        { identifier: second.identifier, policy: second.egressPolicy! },
        [{ identifier: first.identifier, policy: first.egressPolicy! }],
      ),
    ).toEqual({
      identifier: 'billing-api',
      host: 'api.example.com',
      header: 'authorization',
    });

    expect(() =>
      resolveNetworkBoundaryBindings([first, second], {
        sessionId: 'session-1',
        agentGrantEnv: ['billing-api', 'billing-backup'],
        sessionAllowlist: null,
      }),
    ).toThrow('billing-api and billing-backup both target api.example.com header authorization');
  });
});
