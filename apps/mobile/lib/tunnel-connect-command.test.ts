import { describe, expect, test } from 'bun:test';
import { buildTunnelConnectCommand } from './tunnel-connect-command';

describe('buildTunnelConnectCommand', () => {
  test('pins the published CLI and appends the tunnel API root', () => {
    expect(buildTunnelConnectCommand('https://api.kortix.com/v1')).toBe(
      'npx --yes @kortix/agent-tunnel@latest connect --api-url https://api.kortix.com/v1/tunnel',
    );
  });

  test('removes trailing slashes before appending the tunnel API root', () => {
    expect(buildTunnelConnectCommand('https://api.kortix.com/v1/')).toBe(
      'npx --yes @kortix/agent-tunnel@latest connect --api-url https://api.kortix.com/v1/tunnel',
    );
  });
});
