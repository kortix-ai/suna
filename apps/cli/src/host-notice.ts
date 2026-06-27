import {
  activeHostEntry,
  getHost,
  hasEnvTokenHost,
  type Host,
} from './api/config.ts';
import { C } from './style.ts';

export interface HostNotice {
  name: string;
  url: string;
  authState: string;
}

function hostAuthState(host: Host, mode: 'env' | 'stored'): string {
  if (!host.token) return 'not logged in';
  if (mode === 'env') return 'authenticated (project token)';
  if (host.user_email || host.user_id) return `${host.user_email || host.user_id} (user)`;
  return 'authenticated';
}

export function findHostArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') return argv[i + 1];
    if (arg.startsWith('--host=')) return arg.slice('--host='.length);
  }
  return undefined;
}

export function resolveHostNotice(hostArg?: string): HostNotice {
  if (hostArg) {
    const host = getHost(hostArg);
    return {
      name: hostArg,
      url: host?.url ?? 'unconfigured',
      authState: host ? hostAuthState(host, 'stored') : 'not logged in',
    };
  }

  const { name, host } = activeHostEntry();
  return {
    name,
    url: host.url,
    authState: hostAuthState(host, hasEnvTokenHost() ? 'env' : 'stored'),
  };
}

export function renderHostNotice(commandArgv: readonly string[]): string | null {
  const command = commandArgv[0];
  if (!command || ['help', '--help', '-h', 'version'].includes(command)) return null;
  const notice = resolveHostNotice(findHostArg(commandArgv.slice(1)));
  return `${C.dim}host ${C.reset}${C.bold}${notice.name}${C.reset}${C.dim} (${notice.url}, ${notice.authState})${C.reset}\n`;
}
