import { describe, expect, test } from 'bun:test';
import { resolveNetworkBoundaryBindings } from '../secrets/network-boundary';
import {
  NETWORK_BOUNDARY_NOTES,
  buildSecretCapabilities,
  serializeSecretCapabilities,
} from './secret-capabilities';

describe('buildSecretCapabilities', () => {
  test('describes each usable delivery without serializing secret material', () => {
    const capabilities = buildSecretCapabilities(
      [
        {
          identifier: 'RUNTIME_TOKEN',
          key: 'RUNTIME_TOKEN',
          strategy: 'runtime',
          consumer: 'sandbox',
        },
        {
          identifier: 'WEATHER_API',
          key: 'WEATHER_API_KEY',
          strategy: 'broker',
          consumer: 'http_broker',
          egressPolicy: {
            backend: 'kortix_fetch',
            rules: [{ host: 'api.weather.test', methods: ['GET'], path: '/v1/*' }],
            inject: {
              kind: 'header',
              name: 'authorization',
              template: 'Bearer {{secret}}',
            },
            on_no_match: 'deny',
            tls: 'terminate',
          },
        },
        {
          identifier: 'CRM_TOKEN',
          key: 'CRM_TOKEN',
          strategy: 'broker',
          consumer: 'connector',
        },
      ],
      {
        grantEnv: ['RUNTIME_TOKEN', 'WEATHER_API', 'CRM_TOKEN'],
        sessionId: 'session-1',
      },
    );

    expect(capabilities).toEqual({
      version: 1,
      capabilities: [
        {
          identifier: 'CRM_TOKEN',
          delivery: 'kortix_service',
          consumer: 'connector',
        },
        {
          identifier: 'RUNTIME_TOKEN',
          delivery: 'sandbox',
          environment_variable: 'RUNTIME_TOKEN',
        },
        {
          identifier: 'WEATHER_API',
          delivery: 'https_broker',
          command: 'kortix secrets call WEATHER_API <https-url> [options]',
        },
      ],
    });
    const json = JSON.stringify(capabilities);
    expect(json).not.toContain('plaintext-value');
    expect(json).not.toContain('{{secret}}');
    expect(json).not.toContain('KXS1');
  });

  test('omits denied, unavailable, ungranted, and session-excluded secrets', () => {
    const capabilities = buildSecretCapabilities(
      [
        {
          identifier: 'ALLOWED',
          key: 'ALLOWED',
          strategy: 'runtime',
          consumer: 'sandbox',
        },
        {
          identifier: 'DENIED',
          key: 'DENIED',
          strategy: 'denied',
          consumer: null,
        },
        {
          // A network-boundary row with no policy claims no destination, so
          // there is nothing to describe. `resolveNetworkBoundaryBindings`
          // throws on this row, so the session never starts either.
          identifier: 'EGRESS',
          key: 'EGRESS',
          strategy: 'egress',
          consumer: 'network',
        },
        {
          identifier: 'OTHER',
          key: 'OTHER',
          strategy: 'runtime',
          consumer: 'sandbox',
        },
        {
          identifier: 'PATH_SECRET',
          key: 'PATH',
          strategy: 'runtime',
          consumer: 'sandbox',
        },
      ],
      {
        grantEnv: ['ALLOWED', 'DENIED', 'EGRESS', 'PATH_SECRET'],
        sessionAllowlist: ['ALLOWED', 'DENIED', 'EGRESS', 'PATH_SECRET'],
        sessionId: 'session-1',
      },
    );

    expect(capabilities.capabilities.map((item) => item.identifier)).toEqual(['ALLOWED']);
  });

  test('withholds non-runtime capabilities from an unscoped grant', () => {
    const capabilities = buildSecretCapabilities(
      [
        {
          identifier: 'BROKERED',
          key: 'BROKERED',
          strategy: 'broker',
          consumer: 'http_broker',
          egressPolicy: {
            backend: 'kortix_fetch',
            rules: [{ host: 'api.example.test' }],
            inject: { kind: 'query', name: 'api_key' },
          },
        },
      ],
      { grantEnv: 'all', sessionId: 'session-1' },
    );

    expect(capabilities.capabilities).toEqual([]);
  });

  test('caps the environment payload and reports deterministic truncation', () => {
    const catalog = {
      version: 1 as const,
      capabilities: Array.from({ length: 1_000 }, (_, index) => ({
        identifier: `SERVICE_${index.toString().padStart(4, '0')}_${'x'.repeat(100)}`,
        delivery: 'kortix_service' as const,
        consumer: 'connector' as const,
      })),
    };

    const serialized = serializeSecretCapabilities(catalog);
    const parsed = JSON.parse(serialized);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(48 * 1024);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(1_000);
    expect(parsed.capabilities.length).toBeGreaterThan(0);
  });
});

/**
 * The boundary is invisible from inside the sandbox by design, and its one
 * observable symptom — a cut connection — reads as a dead host. An agent told
 * nothing invents an explanation for it (a real session concluded that an echo
 * service had "legacy HTTP/1.1 ALPN negotiation" problems). The catalog is the
 * only channel that can correct that before the guess happens.
 */
describe('buildSecretCapabilities describes the network boundary', () => {
  const NEVER_LEAKS = 'sk_live_never_in_the_catalog';

  const policy = {
    rules: [
      { host: 'Uploads.Stripe.test' },
      { host: 'api.stripe.test' },
      { host: 'api.stripe.test' },
    ],
    inject: { kind: 'header' as const, name: 'Authorization', template: 'Bearer {{secret}}' },
    on_no_match: 'deny' as const,
    tls: 'terminate' as const,
  };

  /** A full stored row, so the same object can drive the provider-edge check. */
  const row = {
    secretId: '00000000-0000-4000-8000-000000000001',
    identifier: 'STRIPE_API_KEY',
    key: 'STRIPE_API_KEY',
    value: NEVER_LEAKS,
    strategy: 'egress' as const,
    consumer: 'network' as const,
    egressPolicy: policy,
  };

  const sandboxRow = {
    identifier: 'LOCAL_TOKEN',
    key: 'LOCAL_TOKEN',
    strategy: 'runtime' as const,
    consumer: 'sandbox' as const,
  };

  type CapabilityRows = Parameters<typeof buildSecretCapabilities>[0];

  const built = (rows: CapabilityRows = [row]) =>
    buildSecretCapabilities(rows, {
      grantEnv: ['STRIPE_API_KEY', 'LOCAL_TOKEN'],
      sessionId: 'session-1',
    });

  test('names the allow-listed hosts and the injected header', () => {
    expect(built().capabilities).toEqual([
      {
        identifier: 'STRIPE_API_KEY',
        delivery: 'network',
        hosts: ['api.stripe.test', 'uploads.stripe.test'],
        header: 'authorization',
        scheme: 'https',
        readable_in_sandbox: false,
        on_echo: 'block',
      },
    ]);
  });

  test('carries no value, no alias, and no header template', () => {
    const json = JSON.stringify(built());
    expect(json).not.toContain(NEVER_LEAKS);
    expect(json).not.toContain('{{secret}}');
    expect(json).not.toContain('Bearer');
    // `bindingAlias` in ../secrets/network-boundary.ts derives the provider-side
    // attachment name from the secret id. The guest must not see that either.
    expect(json).not.toContain(row.secretId.replace(/-/g, ''));
  });

  test('states the echo cut, the HTTPS requirement, and what to probe instead', () => {
    const notes = built().notes?.network ?? [];
    const text = notes.join('\n');
    expect(text).toContain('curl: (52) Empty reply from server');
    expect(text).toContain('The host is not down.');
    expect(text).toContain('HTTPS is required.');
    expect(text).toContain('never one that reflects request headers');
    expect(text).toContain('do not ask the user for it');
    expect(text).toContain('do not build the header yourself');
    expect(notes).toEqual([...NETWORK_BOUNDARY_NOTES]);
  });

  test('describes the same destination the provider edge arms', () => {
    const [binding] = resolveNetworkBoundaryBindings([row], {
      sessionId: 'session-1',
      agentGrantEnv: ['STRIPE_API_KEY'],
      sessionAllowlist: null,
    });
    const capability = built().capabilities[0];
    if (capability?.delivery !== 'network') throw new Error('expected a network capability');
    expect(capability.hosts).toEqual(binding!.hosts);
    expect(capability.header).toBe(binding!.header);
    expect(capability.on_echo).toBe(binding!.onEcho);
    // The armed binding carries the rendered credential. The catalog must not.
    expect(binding!.value).toBe(`Bearer ${NEVER_LEAKS}`);
  });

  test('leaves a sandbox secret unchanged and states the rules once', () => {
    const catalog = built([row, sandboxRow]);

    expect(catalog.capabilities[0]).toEqual({
      identifier: 'LOCAL_TOKEN',
      delivery: 'sandbox',
      environment_variable: 'LOCAL_TOKEN',
    });
    expect(catalog.notes).toEqual({ network: NETWORK_BOUNDARY_NOTES });
  });

  test('omits the notes when no capability needs them', () => {
    const catalog = built([sandboxRow]);
    expect(catalog.notes).toBeUndefined();
    expect(JSON.stringify(catalog)).not.toContain('Empty reply');
  });

  test('advertises nothing for a policy the boundary cannot enforce', () => {
    const unenforceable = [
      { ...policy, rules: [{ host: '*.stripe.test' }] },
      { ...policy, rules: [{ host: 'api.stripe.test', path: '/v1/*' }] },
      { ...policy, rules: [{ host: 'api.stripe.test', methods: ['GET'] }] },
      { ...policy, inject: { kind: 'query' as const, name: 'api_key' } },
      { ...policy, tls: 'tunnel' as const },
      { ...policy, backend: 'kortix_fetch' as const },
    ];
    for (const egressPolicy of unenforceable) {
      expect(built([{ ...row, egressPolicy }]).capabilities).toEqual([]);
    }
  });

  test('keeps the rules inside the truncation budget', () => {
    const identifiers = Array.from(
      { length: 400 },
      (_, index) => `BOUNDARY_${index.toString().padStart(4, '0')}_${'x'.repeat(100)}`,
    );
    const many = buildSecretCapabilities(
      identifiers.map((identifier, index) => ({
        identifier,
        key: `BOUNDARY_${index}`,
        strategy: 'egress' as const,
        consumer: 'network' as const,
        egressPolicy: policy,
      })),
      { grantEnv: identifiers, sessionId: 'session-1' },
    );

    const serialized = serializeSecretCapabilities(many);
    const parsed = JSON.parse(serialized);
    expect(many.capabilities.length).toBe(400);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(48 * 1024);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(400);
    expect(parsed.capabilities.length).toBeGreaterThan(0);
    // A truncated catalog that still lists a network capability keeps its rules.
    expect(parsed.notes.network).toEqual([...NETWORK_BOUNDARY_NOTES]);
  });
});
