/**
 * Where the TUI gets its backend URL and token.
 *
 * There is exactly one auth source: the CLI's multi-host config
 * (`~/.config/kortix/config.json`), read through `@kortix/cli`'s own
 * `src/api/config.ts`. `kortix login` writes it; the TUI only reads it. The
 * TUI never parses that file itself, so a config-format change lands in one
 * place.
 *
 * `KORTIX_API_URL` + `KORTIX_API_KEY` (or `KORTIX_TOKEN`, the name the CLI
 * already honors inside a sandbox) override the config for scripts, tests, and
 * CI. The override never writes to disk.
 *
 * CLI parity cuts both ways: `kortix` itself resolves a synthetic `sandbox`
 * host whenever `KORTIX_TOKEN` is in the environment (`activeHost()` in
 * `apps/cli/src/api/config.ts`), so a stale sandbox token left exported in a
 * developer shell silently outranks `kortix login` for the CLI AND the TUI.
 * The TUI cannot change that precedence without diverging from the CLI, so it
 * names the source (`envVar`) and `src/main.tsx` validates the token at boot
 * and says exactly which variable to unset when it is rejected.
 */

import {
  type Host,
  activeHostName,
  getHost,
  listHosts,
  loadConfig,
  secureRemoteBase,
} from '@kortix/cli/src/api/config.ts';
import { sdkBackendUrl } from '@kortix/cli/src/api/sdk.ts';

export interface ResolvedHost {
  /** Config key (`cloud`, `local-dev`, …), or `env` for the env override. */
  name: string;
  /** Absolute backend base the SDK needs, always ending in `/v1`. */
  backendUrl: string;
  /** Bearer for every call: a PAT, an API key, or a Supabase JWT. */
  token: string;
  /** The host's active account. Empty string when the config has none yet. */
  accountId: string;
  /** The host's default project, when `kortix` recorded one. */
  defaultProjectId?: string;
  /** Signed-in identity, for the status bar. Empty when unknown. */
  userEmail: string;
  /** Which source won. */
  source: 'env' | 'config';
  /** For `source: 'env'`: the variable the token came from. */
  envVar?: 'KORTIX_API_KEY' | 'KORTIX_TOKEN';
}

export interface HostEntry {
  name: string;
  backendUrl: string;
  hasToken: boolean;
  active: boolean;
  userEmail: string;
}

type Env = Record<string, string | undefined>;

function envToken(
  env: Env,
): { token: string; envVar: 'KORTIX_API_KEY' | 'KORTIX_TOKEN' } | undefined {
  const apiKey = env.KORTIX_API_KEY?.trim();
  if (apiKey) return { token: apiKey, envVar: 'KORTIX_API_KEY' };
  const sandboxToken = env.KORTIX_TOKEN?.trim();
  if (sandboxToken) return { token: sandboxToken, envVar: 'KORTIX_TOKEN' };
  return undefined;
}

/**
 * The line the login screen shows when the boot-time `validateToken` fails.
 * Names the variable to unset when the token came from the environment, and
 * the `kortix login` remedy when it came from the config file.
 */
export function tokenRejectionNotice(
  host: Pick<ResolvedHost, 'name' | 'source' | 'envVar' | 'backendUrl'>,
  status: number,
  message: string,
): string {
  const where = `${host.backendUrl} (host ${host.name})`;
  const reason = status ? `${status}: ${message}` : message;
  if (host.source === 'env') {
    const variable = host.envVar ?? 'KORTIX_API_KEY';
    return `Token rejected by ${where} — ${reason}. ${variable} is set in this shell and outranks kortix login; unset it or pick a host below.`;
  }
  return `Token rejected by ${where} — ${reason}. Run kortix login, or pick another host below.`;
}

function envBackendUrl(env: Env): string | undefined {
  const url = env.KORTIX_API_URL?.trim();
  return url || undefined;
}

/**
 * The host this process runs against, or null when nothing is configured
 * (the caller then shows the login screen).
 *
 * Precedence, highest first:
 *   1. `KORTIX_TUI_HOST` — a configured host named BY NAME
 *   2. `KORTIX_API_KEY` (or `KORTIX_TOKEN`) + `KORTIX_API_URL`
 *   3. the active host in the CLI config
 *
 * `KORTIX_TUI_HOST` outranks the env token on purpose. It is how `kortix tui
 * --host <name>` reaches this process (apps/cli/src/commands/tui.ts), and
 * `--host` is an explicit claim about WHICH instance to open. A stale
 * `KORTIX_TOKEN` exported in the shell would otherwise silently win and the
 * flag would do nothing. A name that is gone or has no token falls through to
 * the normal order rather than dead-ending — the CLI already refused that case
 * with `kortix hosts login <name>` before it spawned us.
 *
 * A config host with an empty token is not usable and resolves to null — the
 * user is listed in `listHostEntries()` but has to log in.
 */
export function resolveHost(env: Env = process.env): ResolvedHost | null {
  const named = env.KORTIX_TUI_HOST?.trim();
  if (named) {
    const host = getHost(named);
    if (host?.token) return resolvedFromHost(named, host);
  }

  const fromEnv = envToken(env);
  const url = envBackendUrl(env);
  if (fromEnv) {
    return {
      // The CLI's `activeHostEntry()` names a KORTIX_TOKEN host `sandbox`.
      name: fromEnv.envVar === 'KORTIX_TOKEN' ? 'sandbox' : 'env',
      backendUrl: sdkBackendUrl(url ?? 'https://api.kortix.com'),
      token: fromEnv.token,
      accountId: env.KORTIX_ACCOUNT_ID?.trim() ?? '',
      defaultProjectId: env.KORTIX_PROJECT_ID?.trim() || undefined,
      userEmail: '',
      source: 'env',
      envVar: fromEnv.envVar,
    };
  }

  const name = activeHostName();
  const config = loadConfig();
  const host: Host | undefined = name ? config.hosts[name] : undefined;
  if (!name || !host || !host.token) return null;

  return {
    name,
    // An explicit `KORTIX_API_URL` still re-points a config host (CLI parity),
    // but without a token it cannot create one.
    backendUrl: sdkBackendUrl(url ?? host.url),
    token: host.token,
    accountId: host.account_id ?? '',
    defaultProjectId: host.default_project?.project_id,
    userEmail: host.user_email ?? '',
    source: 'config',
  };
}

/** Every configured host, for the host switcher and the login screen. */
export function listHostEntries(): HostEntry[] {
  return listHosts().map((entry) => ({
    name: entry.name,
    backendUrl: sdkBackendUrl(entry.host.url),
    hasToken: Boolean(entry.host.token),
    active: entry.active,
    userEmail: entry.host.user_email ?? '',
  }));
}

/** The origin without the `/v1` mount — for display and for PTY URLs. */
export function hostOrigin(backendUrl: string): string {
  return secureRemoteBase(backendUrl).replace(/\/v1$/, '');
}

/** The `ResolvedHost` a stored CLI host record resolves to. */
export function resolvedFromHost(name: string, host: Host): ResolvedHost {
  return {
    name,
    backendUrl: sdkBackendUrl(host.url),
    token: host.token,
    accountId: host.account_id ?? '',
    defaultProjectId: host.default_project?.project_id,
    userEmail: host.user_email ?? '',
    source: 'config',
  };
}

/**
 * A row from the host list → the host this process would run against.
 *
 * `resolveHost()` only ever answers for the ACTIVE host, and `listHostEntries()`
 * deliberately drops the token. Selecting a row means resolving THAT row, so
 * the token is read back here by name. Returns null when the host is gone or
 * carries no token.
 *
 * `read` is injected so a test never touches a real
 * `~/.config/kortix/config.json`.
 */
export function hostToResolved(
  entry: Pick<HostEntry, 'name'>,
  deps: { read: (name: string) => Host | null } = { read: getHost },
): ResolvedHost | null {
  const host = deps.read(entry.name);
  if (!host || !host.token) return null;
  return resolvedFromHost(entry.name, host);
}
