import { describe, expect, test } from 'bun:test';
import { buildSSHConnectionInfo, buildSSHSetupPayload, resolvePublicSSHHost } from '../platform/services/ssh-access';

describe('ssh access helpers', () => {
  test('builds stable ssh commands and config from connection info', () => {
    const connection = buildSSHConnectionInfo({
      host: '204.168.249.53',
      port: 22,
      username: 'abc',
      provider: 'justavps',
    });

    expect(connection.key_name).toBe('kortix_204-168-249-53');
    expect(connection.host_alias).toBe('kortix-204-168-249-53');
    expect(connection.reconnect_command).toContain('ssh -i ~/.ssh/kortix_204-168-249-53');
    expect(connection.reconnect_command).toContain('-p 22 abc@204.168.249.53');
    expect(connection.ssh_config_entry).toContain('Host kortix-204-168-249-53');
  });

  test('builds setup payload around the stable connection info', () => {
    const connection = buildSSHConnectionInfo({
      host: 'api.kortix.dev',
      port: 14007,
      username: 'abc',
      provider: 'local_docker',
    });
    const payload = buildSSHSetupPayload({
      connection,
      privateKey: 'PRIVATE-KEY',
      publicKey: 'ssh-ed25519 AAAA comment',
      keyComment: 'kortix-api-kortix-dev',
    });

    expect(payload.setup_command).toContain('cat > ~/.ssh/kortix_api-kortix-dev');
    expect(payload.setup_command).toContain(connection.reconnect_command);
    expect(payload.agent_prompt).toContain(connection.host_alias);
    expect(payload.ssh_command).toBe(connection.reconnect_command);
  });

  test('resolves public SSH host from forwarded headers first', () => {
    const c = {
      req: {
        header(name: string) {
          if (name === 'x-forwarded-host') return 'ssh.kortix.dev:8008';
          if (name === 'host') return 'localhost:8008';
          return null;
        },
      },
    } as any;

    expect(resolvePublicSSHHost(c)).toBe('ssh.kortix.dev');
  });
});
