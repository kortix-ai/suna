import { describe, expect, test } from 'bun:test';
import { buildSecretCapabilities, serializeSecretCapabilities } from './secret-capabilities';

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
