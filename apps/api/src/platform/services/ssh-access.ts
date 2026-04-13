import type { Context } from 'hono';
import { config } from '../../config';

export interface SSHConnectionInfo {
  host: string;
  port: number;
  username: string;
  provider: string;
  key_name: string;
  host_alias: string;
  reconnect_command: string;
  ssh_command: string;
  ssh_config_entry: string;
  ssh_config_command: string;
}

export interface SSHSetupPayload extends SSHConnectionInfo {
  private_key: string;
  public_key: string;
  setup_command: string;
  agent_prompt: string;
  key_comment: string;
}

function sanitizeHostToken(host: string): string {
  const cleaned = host
    .replace(/^\[|\]$/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned || 'sandbox';
}

function extractHostname(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return '';
    }
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end !== -1 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(':')[0];
}

export function resolvePublicSSHHost(c: Context): string {
  const headerCandidates = [
    c.req.header('x-forwarded-host') || '',
    c.req.header('host') || '',
  ];

  for (const raw of headerCandidates) {
    const host = extractHostname(raw);
    if (!host) continue;
    if (host === 'host.docker.internal' || host === 'kortix-api') continue;
    return host;
  }

  const configCandidates = [config.KORTIX_URL, config.FRONTEND_URL];
  for (const raw of configCandidates) {
    const host = extractHostname(raw);
    if (!host) continue;
    if (host === 'host.docker.internal' || host === 'kortix-api') continue;
    return host;
  }

  return 'localhost';
}

export function buildSSHConnectionInfo(opts: {
  host: string;
  port: number;
  username: string;
  provider: string;
}): SSHConnectionInfo {
  const hostToken = sanitizeHostToken(opts.host);
  const keyName = `kortix_${hostToken}`;
  const hostAlias = `kortix-${hostToken}`;
  const reconnectCommand = `ssh -i ~/.ssh/${keyName} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -p ${opts.port} ${opts.username}@${opts.host}`;
  const sshConfigEntry = `Host ${hostAlias}\n  HostName ${opts.host}\n  Port ${opts.port}\n  User ${opts.username}\n  IdentityFile ~/.ssh/${keyName}\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  ServerAliveInterval 15\n  ServerAliveCountMax 4`;
  const sshConfigCommand = `mkdir -p ~/.ssh && touch ~/.ssh/config && chmod 600 ~/.ssh/config && grep -q "Host ${hostAlias}" ~/.ssh/config 2>/dev/null || cat >> ~/.ssh/config << 'KORTIX_SSH_CONFIG'\n\n${sshConfigEntry}\nKORTIX_SSH_CONFIG`;

  return {
    host: opts.host,
    port: opts.port,
    username: opts.username,
    provider: opts.provider,
    key_name: keyName,
    host_alias: hostAlias,
    reconnect_command: reconnectCommand,
    ssh_command: reconnectCommand,
    ssh_config_entry: sshConfigEntry,
    ssh_config_command: sshConfigCommand,
  };
}

export function buildSSHSetupPayload(opts: {
  connection: SSHConnectionInfo;
  privateKey: string;
  publicKey: string;
  keyComment: string;
}): SSHSetupPayload {
  const pk = opts.privateKey.trim();
  const setupCommand = `mkdir -p ~/.ssh && cat > ~/.ssh/${opts.connection.key_name} << 'KORTIX_KEY'\n${pk}\nKORTIX_KEY\nchmod 600 ~/.ssh/${opts.connection.key_name} && ${opts.connection.reconnect_command}`;
  const agentPrompt = `Set up SSH access to my remote Kortix instance and connect via Remote-SSH.\n\n1. Save the SSH key:\n${setupCommand}\n\n2. Add to ~/.ssh/config:\n${opts.connection.ssh_config_entry}\n\n3. Connect via Remote-SSH to host "${opts.connection.host_alias}"`;

  return {
    ...opts.connection,
    private_key: opts.privateKey,
    public_key: opts.publicKey,
    setup_command: setupCommand,
    agent_prompt: agentPrompt,
    key_comment: opts.keyComment,
  };
}
