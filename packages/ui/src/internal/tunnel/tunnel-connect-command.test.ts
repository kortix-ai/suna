import { describe, expect, test } from 'bun:test';
import { absoluteBackendUrl, buildTunnelConnectCommand } from './tunnel-connect-command';

describe('buildTunnelConnectCommand', () => {
  test('keeps absolute API URLs and appends the tunnel root', () => {
    expect(
      buildTunnelConnectCommand({
        backendUrl: 'https://dev-api.kortix.com/v1/',
        origin: 'https://dev.kortix.com',
      }),
    ).toBe(
      'npx --yes @kortix/agent-tunnel@latest connect --api-url https://dev-api.kortix.com/v1/tunnel',
    );
  });

  test('resolves root-relative API URLs against the browser origin', () => {
    expect(
      buildTunnelConnectCommand({
        backendUrl: '/v1',
        origin: 'https://dev.kortix.com',
      }),
    ).toBe(
      'npx --yes @kortix/agent-tunnel@latest connect --api-url https://dev.kortix.com/v1/tunnel',
    );
  });

  test('offers "Also share with <project>" on the approval page', () => {
    expect(
      buildTunnelConnectCommand({
        backendUrl: 'https://dev-api.kortix.com/v1',
        origin: 'https://dev.kortix.com',
        projectId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBe(
      'npx --yes @kortix/agent-tunnel@latest connect --api-url https://dev-api.kortix.com/v1/tunnel --project-id 00000000-0000-4000-8000-000000000001',
    );
  });
});

describe('absoluteBackendUrl', () => {
  test('is the API root the desktop app pairs against', () => {
    expect(absoluteBackendUrl({ backendUrl: '/v1/', origin: 'http://localhost:3000' })).toBe(
      'http://localhost:3000/v1',
    );
    expect(absoluteBackendUrl({ backendUrl: 'http://localhost:8008/v1', origin: 'http://x' })).toBe(
      'http://localhost:8008/v1',
    );
  });
});
