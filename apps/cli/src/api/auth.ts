import {
  DEFAULT_API_BASE,
  DEFAULT_HOST_NAME,
  activeHost,
  activeHostName,
  configFilePath,
  getHost,
  upsertHost,
  removeHost,
  type Host,
} from './config.ts';

// Backward-compatible auth surface — every existing command imports
// `Auth`, `loadAuth`, `saveAuth`, `clearAuth`, `authFileLocation` from
// here. Internally we now delegate to the multi-host config store, but
// the shape callers see is unchanged.

export { DEFAULT_API_BASE };

export interface Auth {
  /** Base URL of the Kortix API, e.g. https://api.kortix.com */
  api_base: string;
  /** kortix_pat_... token */
  token: string;
  /** Identity captured at login time (display only). */
  user_id: string;
  user_email: string;
  /** Active account id this CLI acts on by default. */
  account_id: string;
  /** Persisted timestamp (ISO). */
  logged_in_at: string;
}

function hostToAuth(host: Host): Auth {
  return {
    api_base: host.url,
    token: host.token,
    user_id: host.user_id,
    user_email: host.user_email,
    account_id: host.account_id,
    logged_in_at: host.logged_in_at,
  };
}

function authToHost(auth: Auth): Host {
  return {
    url: auth.api_base,
    token: auth.token,
    user_id: auth.user_id,
    user_email: auth.user_email,
    account_id: auth.account_id,
    logged_in_at: auth.logged_in_at,
  };
}

/** Load the active host's auth. Honors KORTIX_CLI_TOKEN env override. */
export function loadAuth(): Auth | null {
  const host = activeHost();
  return host ? hostToAuth(host) : null;
}

/** Load a specific named host's auth (for --host overrides). */
export function loadAuthForHost(name: string): Auth | null {
  const host = getHost(name);
  return host ? hostToAuth(host) : null;
}

/** Persist the active host. Saves under the active host name, or under
 * `cloud` if no hosts are configured yet. Marks the touched host
 * active. */
export function saveAuth(auth: Auth): void {
  const targetName = activeHostName() ?? DEFAULT_HOST_NAME;
  upsertHost(targetName, authToHost(auth), true);
}

/** Persist a named host explicitly. */
export function saveAuthForHost(name: string, auth: Auth, makeActive: boolean): void {
  upsertHost(name, authToHost(auth), makeActive);
}

/** Remove the active host (or a named one). Returns true if anything was removed. */
export function clearAuth(name?: string): boolean {
  const target = name ?? activeHostName();
  if (!target) return false;
  return removeHost(target).removed;
}

/** Display path of the config file backing this CLI's auth state. */
export function authFileLocation(): string {
  return configFilePath();
}

/** Resolve the API base URL the CLI should use for "no auth yet" calls. */
export function resolveApiBase(): string {
  if (process.env.KORTIX_API_URL) return process.env.KORTIX_API_URL;
  const host = activeHost();
  return host?.url ?? DEFAULT_API_BASE;
}
