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
 * The substitution is invisible from inside the sandbox by design: the agent
 * sends a handle and Kortix swaps it upstream. An agent told nothing invents an
 * explanation for every symptom it meets (a real session concluded that an echo
 * service had "legacy HTTP/1.1 ALPN negotiation" problems). The catalog is the
 * only channel that can correct that before the guess happens.
 */
describe('buildSecretCapabilities describes egress-enforced delivery', () => {
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

  /** A full stored row, so the same object can drive the session-binding check. */
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

  test('names the env var holding the handle and the allow-listed hosts', () => {
    expect(built().capabilities).toEqual([
      {
        identifier: 'STRIPE_API_KEY',
        delivery: 'network',
        environment_variable: 'STRIPE_API_KEY',
        hosts: ['api.stripe.test', 'uploads.stripe.test'],
        scheme: 'https',
        readable_in_sandbox: false,
        on_echo: 'redact',
      },
    ]);
  });

  test('carries no value, no alias, no header name and no header template', () => {
    const json = JSON.stringify(built());
    expect(json).not.toContain(NEVER_LEAKS);
    expect(json).not.toContain('{{secret}}');
    // `bindingAlias` in ../secrets/network-boundary.ts derives a stable
    // attachment name from the secret id. The guest must not see that either.
    expect(json).not.toContain(row.secretId.replace(/-/g, ''));
    // The network CAPABILITY object reveals no injection header shape — an agent
    // that could read where a credential auto-attaches would start assembling
    // one. Scoped to the capabilities: the usage NOTES do name
    // `Authorization: Bearer $VAR` as generic guidance (that is where an agent
    // SHOULD put the handle), which carries no per-secret config.
    const capabilities = JSON.stringify(built().capabilities);
    expect(capabilities).not.toContain('Bearer');
    expect(capabilities).not.toContain('authorization');
    expect(capabilities).not.toContain('{{secret}}');
  });

  test('states the handle, the substitution, the [REDACTED] echo and the fallback', () => {
    const notes = built().notes?.network ?? [];
    const text = notes.join('\n');
    expect(text).toContain('holds a HANDLE, not the value');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('is a REAL failure');
    expect(text).toContain('over HTTPS');
    expect(text).toContain('do not ask the user for it');
    expect(text).toContain('kortix secrets call');
    // ONE symptom set now. The provider-edge story (an empty reply meaning
    // success) is the exact inversion that would make an agent read a dead host
    // as a working boundary, so it must not survive anywhere in the catalog.
    expect(text).not.toContain('Empty reply from server');
    expect(text).not.toContain('cut mid-flight');
    expect(notes).toEqual([...NETWORK_BOUNDARY_NOTES]);
  });

  test('describes the same hosts the session binding carries', () => {
    const [binding] = resolveNetworkBoundaryBindings([row], {
      sessionId: 'session-1',
      agentGrantEnv: ['STRIPE_API_KEY'],
      sessionAllowlist: null,
    });
    const capability = built().capabilities[0];
    if (capability?.delivery !== 'network') throw new Error('expected a network capability');
    expect(capability.hosts).toEqual(binding!.hosts);
    // Neither side carries credential material any more: the value is fetched
    // by the broker route per request and never enters a binding.
    expect(JSON.stringify(binding)).not.toContain(NEVER_LEAKS);
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
    expect(JSON.stringify(catalog)).not.toContain('[REDACTED]');
  });

  // The default shape since the exposure/usage model §6: hosts only, no slot.
  test('advertises a substitution-only policy that names no injection slot', () => {
    const hostsOnly = { rules: policy.rules, on_no_match: 'deny' as const };
    expect(built([{ ...row, egressPolicy: hostsOnly }]).capabilities).toEqual([
      {
        identifier: 'STRIPE_API_KEY',
        delivery: 'network',
        environment_variable: 'STRIPE_API_KEY',
        hosts: ['api.stripe.test', 'uploads.stripe.test'],
        scheme: 'https',
        readable_in_sandbox: false,
        on_echo: 'redact',
      },
    ]);
  });

  test('advertises nothing for a policy this path cannot enforce', () => {
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

/**
 * ONE symptom set, because there is ONE mechanism.
 *
 * There used to be two, and they produced OPPOSITE symptoms for the same
 * working request: the Platinum edge CUT an echoing response (an empty reply
 * meant success) while the relay REDACTS it (a 200 containing `[REDACTED]`
 * means success). Telling an agent the wrong story made it read a dead host as
 * a working boundary, or read success as failure. The edge is gone
 * (docs/specs/2026-08-19-secrets-exposure-usage-model.md §4), so the catalog
 * must state exactly one of them, unconditionally — no caller-supplied mode, no
 * default, nothing to get wrong.
 */
describe('echo guidance has one story and no mode to choose', () => {
  const boundaryRow = {
    secretId: '00000000-0000-4000-8000-0000000000ff',
    identifier: 'BOUNDARY_ONE',
    key: 'BOUNDARY_ONE',
    value: 'sk_never_in_the_catalog',
    strategy: 'egress' as const,
    consumer: 'network' as const,
    egressPolicy: {
      rules: [{ host: 'api.example.com' }],
      on_no_match: 'deny' as const,
      tls: 'terminate' as const,
    },
  };
  const build = () =>
    buildSecretCapabilities([boundaryRow], {
      grantEnv: ['BOUNDARY_ONE'],
      // Egress-enforced delivery is handle-based, so it is withheld entirely
      // without a session — without this the catalog is empty and every
      // assertion below would vacuously pass on `undefined`.
      sessionId: 'session-1',
    });

  test('says [REDACTED] is success and an empty reply is NOT', () => {
    const catalog = build();
    expect(catalog.capabilities[0]).toMatchObject({ delivery: 'network', on_echo: 'redact' });
    const notes = (catalog.notes?.network ?? []).join(' ');
    expect(notes).toContain('[REDACTED]');
    expect(notes).toContain('is a REAL failure');
    // The exact inversion that would mislead an agent.
    expect(notes).not.toContain('Empty reply from server');
    expect(notes).not.toContain('cut mid-flight');
  });

  test('still forbids inventing a credential and names the explicit fallback', () => {
    const notes = (build().notes?.network ?? []).join(' ');
    expect(notes).toContain('do not invent a credential');
    expect(notes).toContain('The value is not in this sandbox');
    expect(notes).toContain('kortix secrets call <identifier> <https-url>');
  });
});
