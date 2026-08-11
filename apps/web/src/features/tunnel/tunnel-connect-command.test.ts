import { describe, expect, test } from 'bun:test';
import { buildTunnelConnectCommand } from './tunnel-connect-command';

describe('buildTunnelConnectCommand', () => {
  test('keeps absolute API URLs and appends the tunnel root', () => {
    expect(
      buildTunnelConnectCommand({
        backendUrl: 'https://dev-api.dosco.live/v1/',
        origin: 'https://dev.dosco.live',
      }),
    ).toBe(
      'npx --yes @kortix/agent-tunnel@latest connect --api-url https://dev-api.dosco.live/v1/tunnel',
    );
  });

  test('resolves root-relative API URLs against the browser origin', () => {
    expect(
      buildTunnelConnectCommand({
        backendUrl: '/v1',
        origin: 'https://dev.dosco.live',
      }),
    ).toBe(
      'npx --yes @kortix/agent-tunnel@latest connect --api-url https://dev.dosco.live/v1/tunnel',
    );
  });
});
