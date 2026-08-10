import { describe, expect, it, vi } from 'vitest';
import { assertTargetSmokeHealth, resolveTargetSmokeConfig } from '../src/core/target-smoke';

const SHA = 'a'.repeat(40);

describe('deployed staging smoke', () => {
  it('accepts only the exact staging API, web, gateway, and source SHA', () => {
    expect(
      resolveTargetSmokeConfig({
        KE2E_API_URL: 'https://staging-api.kortix.com/v1/',
        E2E_BASE_URL: 'https://staging.kortix.com/',
        KE2E_GATEWAY_URL: 'https://gateway-staging.kortix.com/',
        KE2E_EXPECT_SHA: SHA,
      }),
    ).toEqual({
      apiUrl: 'https://staging-api.kortix.com/v1',
      webUrl: 'https://staging.kortix.com',
      gatewayUrl: 'https://gateway-staging.kortix.com',
      expectedSha: SHA,
    });
  });

  it.each([
    ['production API', { KE2E_API_URL: 'https://api.kortix.com/v1' }],
    ['development API', { KE2E_API_URL: 'https://dev-api.kortix.com/v1' }],
    ['production web', { E2E_BASE_URL: 'https://kortix.com' }],
    ['development gateway', { KE2E_GATEWAY_URL: 'https://gateway-dev.kortix.com' }],
  ])('rejects the %s target', (_name, override) => {
    expect(() =>
      resolveTargetSmokeConfig({
        KE2E_API_URL: 'https://staging-api.kortix.com/v1',
        E2E_BASE_URL: 'https://staging.kortix.com',
        KE2E_GATEWAY_URL: 'https://gateway-staging.kortix.com',
        KE2E_EXPECT_SHA: SHA,
        ...override,
      }),
    ).toThrow('target smoke requires');
  });

  it('rejects a missing source SHA', () => {
    expect(() =>
      resolveTargetSmokeConfig({
        KE2E_API_URL: 'https://staging-api.kortix.com/v1',
        E2E_BASE_URL: 'https://staging.kortix.com',
        KE2E_GATEWAY_URL: 'https://gateway-staging.kortix.com',
      }),
    ).toThrow('KE2E_EXPECT_SHA');
  });

  it('requires both deployed services to report the exact release SHA', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ok', environment: 'staging', commit: SHA }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'healthy', commit: SHA }), {
          status: 200,
        }),
      );

    await expect(
      assertTargetSmokeHealth(
        {
          apiUrl: 'https://staging-api.kortix.com/v1',
          webUrl: 'https://staging.kortix.com',
          gatewayUrl: 'https://gateway-staging.kortix.com',
          expectedSha: SHA,
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
  });

  it('fails when staging serves another SHA', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'ok', environment: 'staging', commit: 'b'.repeat(40) }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'healthy', commit: SHA }), {
          status: 200,
        }),
      );

    await expect(
      assertTargetSmokeHealth(
        {
          apiUrl: 'https://staging-api.kortix.com/v1',
          webUrl: 'https://staging.kortix.com',
          gatewayUrl: 'https://gateway-staging.kortix.com',
          expectedSha: SHA,
        },
        fetchImpl,
      ),
    ).rejects.toThrow('staging SHA mismatch');
  });
});
