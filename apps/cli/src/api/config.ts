import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { sandboxEnvValue } from './sandbox-env.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Multi-host config storage.
//
// File layout: ~/.config/kortix/config.json (mode 0600)
//
//   {
//     "active": "cloud",
//     "hosts": {
//       "cloud": {
//         "url": "https://api.kortix.com",
//         "token": "kortix_pat_...",
//         "user_id": "...",
//         "user_email": "...",
//         "account_id": "...",
//         "logged_in_at": "2026-05-19T..."
//       },
//       "local": { "url": "http://localhost:13738", "token": "", ... },
//       "dev": { "url": "http://localhost:8008", "token": "", ... }
//     }
//   }
//
// One host is "active" at a time — every command operates against it
// unless overridden by `--host <name>` for a single invocation.
//
// Single-host auth files are read on first load and moved into a `cloud`
// host so users can switch cleanly between Kortix Cloud and self-hosted APIs.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_API_BASE = process.env.KORTIX_DEFAULT_API_BASE ?? 'https://api.kortix.com';
// Local `pnpm dev` API server.
export const DEFAULT_LOCAL_DEV_API_BASE = 'http://localhost:8008';
// Kortix-internal hosted dev API.
export const DEFAULT_INTERNAL_DEV_API_BASE = 'https://dev-api.kortix.com';
// The self-host Docker stack publishes its API on this port by default
// (see `kortix self-host` DEFAULT_API_URL). The built-in `selfhost` host is
// pre-pointed here so `kortix hosts use selfhost` works before login;
// `kortix self-host start` rewrites it to the actual published port.
export const DEFAULT_SELFHOST_API_BASE = 'http://localhost:13738';

export const CLOUD_HOST_NAME = 'cloud';
export const LOCAL_DEV_HOST_NAME = 'local-dev';
export const INTERNAL_DEV_HOST_NAME = 'kortix-internal-dev';
export const SELFHOST_HOST_NAME = 'selfhost';
export const DEFAULT_HOST_NAME = CLOUD_HOST_NAME;

// Legacy built-in names migrated to the new scheme on load.
const LEGACY_DEV_HOST_NAME = 'dev'; // → local-dev (localhost:8008)
const LEGACY_LOCAL_HOST_NAME = 'local'; // → selfhost (localhost:13738)
const LEGACY_LOCAL_API_BASE = 'http://localhost:13738';

/** The global default workspace for a host — used by every workspace-scoped
 *  command (connectors, sessions, …) when the cwd is not bound
 *  to a workspace via `.kortix/link.json`. Carries its account_id so the
 *  default always resolves under the right account. */
export interface DefaultWorkspaceRef {
  workspace_id: string;
  account_id: string;
  name?: string;
}

/** @deprecated Use `DefaultWorkspaceRef`. */
export interface DefaultProjectRef {
  project_id: string;
  workspace_id?: string;
  account_id: string;
  name?: string;
}

export interface Host {
  url: string;
  token: string;
  user_id: string;
  user_email: string;
  /** The host's active account id — every account-scoped call defaults to it. */
  account_id: string;
  /** Active account display fields, captured at login / `accounts use`. */
  account_slug?: string;
  account_name?: string;
  /** Global default workspace for this host (see DefaultWorkspaceRef). */
  default_workspace?: DefaultWorkspaceRef;
  /** @deprecated Read during migration. New writes use `default_workspace`. */
  default_project?: DefaultProjectRef;
  /**
   * The frontend/dashboard base URL for this host, when known authoritatively
   * (e.g. `kortix self-host` registers it from its own `PUBLIC_URL`). Lets
   * `kortix login`'s browser flow open the right origin instead of guessing
   * one from the API host's shape — that guess (see web-url.ts) assumes cloud
   * URL conventions (`api.<domain>` → `<domain>`, `:8008` → `:3000`) which
   * silently breaks for a self-host stack on non-default ports.
   */
  dashboard_url?: string;
  logged_in_at: string;
}

export interface ActiveAccount {
  id: string;
  slug: string;
  name: string;
}

export interface Config {
  active: string;
  hosts: Record<string, Host>;
}

// ─── File path resolution ──────────────────────────────────────────────────

function defaultConfigPath(): string {
  return resolve(homedir(), '.config', 'kortix', 'config.json');
}

export function configFilePath(): string {
  // Honor both config path env vars. KORTIX_AUTH_FILE is still used by the
  // existing e2e test harness.
  return process.env.KORTIX_CONFIG_FILE ?? process.env.KORTIX_AUTH_FILE ?? defaultConfigPath();
}

function singleHostAuthFilePath(): string {
  return resolve(homedir(), '.config', 'kortix', 'auth.json');
}

/** Only pull from the single-host auth file when the caller is using the
 *  default config file location. Custom paths get a fresh empty config:
 *  they are usually tests or scratch envs that must not mutate real auth. */
function shouldImportSingleHostAuth(currentPath: string): boolean {
  return currentPath === defaultConfigPath();
}

// ─── Load / save ──────────────────────────────────────────────────────────

export function loadConfig(): Config {
  // Try the multi-host file first.
  const path = configFilePath();
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Config>;
      if (parsed && typeof parsed === 'object' && parsed.hosts) {
        return normalizeConfig(parsed);
      }
      // Single-host auth schema at the override path: import in place.
      const migrated = importSingleHostAuth(parsed);
      if (migrated) {
        saveConfig(migrated);
        return migrated;
      }
    } catch {
      /* corrupted file — fall through to empty */
    }
  }

  // Import from ~/.config/kortix/auth.json only when the caller is using the
  // default config path. Test/scratch envs pointed elsewhere should stay empty.
  if (shouldImportSingleHostAuth(path)) {
    const singleHostAuth = singleHostAuthFilePath();
    if (existsSync(singleHostAuth)) {
      try {
        const parsed = JSON.parse(readFileSync(singleHostAuth, 'utf8')) as Record<string, unknown>;
        const migrated = importSingleHostAuth(parsed);
        if (migrated) {
          saveConfig(migrated);
          rmSync(singleHostAuth, { force: true });
          return migrated;
        }
      } catch {
        /* unreadable — ignore */
      }
    }
  }

  return normalizeConfig({ active: DEFAULT_HOST_NAME, hosts: {} });
}

export function saveConfig(config: Config): void {
  const path = configFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    // Belt-and-braces for pre-existing files whose mode predates this fix —
    // writeFileSync's `mode` option only applies when the file is created.
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
}

export function deleteConfig(): void {
  const path = configFilePath();
  if (existsSync(path)) rmSync(path, { force: true });
}

// ─── Active host helpers ──────────────────────────────────────────────────

/**
 * Resolve the active Host for the current invocation. Priority:
 *   1. KORTIX_CLI_TOKEN env var (synthetic ephemeral host, never persisted).
 *      It carries the session-scoped PAT the platform injects into a sandbox.
 *      (The SANDBOX credential
 *      — KORTIX_SANDBOX_TOKEN / its legacy KORTIX_TOKEN alias — is deliberately
 *      NOT used here: it's the daemon's identity, not the user's, and does not
 *      authenticate against the project-scoped API routes the CLI calls.)
 *   2. KORTIX_API_URL env var (URL override for the stored active host)
 *   3. `--host` flag (handled at the call site via `getHost(name)`)
 *   4. The `active` host in config.json
 */
/**
 * True when the platform-injected `KORTIX_CLI_TOKEN` is present.
 * `activeHost()` then resolves to a
 * synthetic env host, which must outrank a `.kortix/link.json` host —
 * inside a sandbox the named host has no stored credentials, so honoring
 * the link would strand a fully-authenticated CLI on "not logged in".
 */
function sandboxCliToken(): string | undefined {
  return sandboxEnvValue('KORTIX_CLI_TOKEN');
}

export function hasEnvTokenHost(): boolean {
  return Boolean(sandboxCliToken());
}

export function activeHost(): Host | null {
  const envToken = sandboxCliToken();
  if (envToken) {
    return {
      url: sandboxEnvValue('KORTIX_API_URL') ?? DEFAULT_API_BASE,
      token: envToken,
      user_id: '',
      user_email: '',
      account_id: '',
      logged_in_at: new Date().toISOString(),
    };
  }
  const config = loadConfig();
  const host = config.hosts[config.active];
  if (!host) return null;
  const envApiUrl = sandboxEnvValue('KORTIX_API_URL');
  if (envApiUrl) return { ...host, url: envApiUrl };
  return host;
}

export function getHost(name: string): Host | null {
  const config = loadConfig();
  return config.hosts[name] ?? null;
}

export function listHosts(): { name: string; host: Host; active: boolean }[] {
  const config = loadConfig();
  return Object.entries(config.hosts)
    .map(([name, host]) => ({ name, host, active: name === config.active }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function activeHostEntry(): { name: string; host: Host } {
  const envHost = activeHost();
  if (sandboxCliToken() && envHost) return { name: 'sandbox', host: envHost };
  if (sandboxEnvValue('KORTIX_API_URL') && envHost) return { name: 'env', host: envHost };
  const config = loadConfig();
  const name = config.hosts[config.active] ? config.active : DEFAULT_HOST_NAME;
  return { name, host: config.hosts[name] ?? defaultHost(DEFAULT_API_BASE) };
}

export function activeHostName(): string | null {
  const config = loadConfig();
  return config.hosts[config.active] ? config.active : null;
}

// ─── Active account + default workspace ────────────────────────────────────

/** The active account for the current invocation (the active host's
 *  stored account), or null when there's no host / no account yet (e.g.
 *  inside a sandbox, where the env host carries no account). */
export function activeAccount(): ActiveAccount | null {
  const host = activeHost();
  if (!host || !host.account_id) return null;
  return {
    id: host.account_id,
    slug: host.account_slug || host.account_id.slice(0, 8),
    name: host.account_name || '',
  };
}

/** The active host's global default workspace, or null when none is set. */
export function defaultWorkspace(): DefaultWorkspaceRef | null {
  const host = activeHost();
  return host?.default_workspace ?? null;
}

/** @deprecated Use `defaultWorkspace`. */
export function defaultProject(): DefaultProjectRef | null {
  const workspace = defaultWorkspace();
  if (!workspace) return null;
  return {
    project_id: workspace.workspace_id,
    account_id: workspace.account_id,
    name: workspace.name,
  };
}

/** Plain "Name (slug)" label, or just the slug when no name is known (a
 *  pre-name-capture login). Avoids the ugly "slug (slug)" duplication. */
export function accountLabel(a: { name?: string; slug: string }): string {
  return a.name ? `${a.name} (${a.slug})` : a.slug;
}

/** Switch the active account on a host (default: the active host). A
 *  default workspace that no longer lives in the active account is dropped —
 *  the default must always be reachable under the active account. */
export function setActiveAccount(
  account: { id: string; slug?: string; name?: string },
  hostName?: string,
): void {
  const config = loadConfig();
  const name = resolveTargetHostName(config, hostName);
  const host = config.hosts[name];
  if (!host) return;
  host.account_id = account.id;
  host.account_slug = account.slug ?? account.id.slice(0, 8);
  host.account_name = account.name ?? '';
  if (host.default_workspace && host.default_workspace.account_id !== account.id) {
    delete host.default_workspace;
  }
  saveConfig(config);
}

/** Set the global default workspace on a host (default: the active host). */
export function setDefaultWorkspace(workspace: DefaultWorkspaceRef, hostName?: string): void {
  const config = loadConfig();
  const name = resolveTargetHostName(config, hostName);
  const host = config.hosts[name];
  if (!host) return;
  host.default_workspace = {
    workspace_id: workspace.workspace_id,
    account_id: workspace.account_id,
    ...(workspace.name ? { name: workspace.name } : {}),
  };
  saveConfig(config);
}

/** Set the global default project through the canonical Workspace storage. */
export function setDefaultProject(project: DefaultProjectRef, hostName?: string): void {
  setDefaultWorkspace(
    {
      workspace_id: project.workspace_id ?? project.project_id,
      account_id: project.account_id,
      name: project.name,
    },
    hostName,
  );
}

/** Clear the global default workspace. Returns true if one was removed. */
export function clearDefaultWorkspace(hostName?: string): boolean {
  const config = loadConfig();
  const name = resolveTargetHostName(config, hostName);
  const host = config.hosts[name];
  if (!host?.default_workspace) return false;
  delete host.default_workspace;
  saveConfig(config);
  return true;
}

/** @deprecated Use `clearDefaultWorkspace`. */
export const clearDefaultProject = clearDefaultWorkspace;

function resolveTargetHostName(config: Config, hostName?: string): string {
  if (hostName) return hostName;
  return config.hosts[config.active] ? config.active : DEFAULT_HOST_NAME;
}

// ─── Mutations ────────────────────────────────────────────────────────────

export function upsertHost(name: string, host: Host, makeActive = false): void {
  validateHostName(name);
  const config = loadConfig();
  config.hosts[name] = host;
  if (makeActive || Object.keys(config.hosts).length === 1) {
    config.active = name;
  }
  saveConfig(config);
}

export function removeHost(name: string): { removed: boolean; switchedTo?: string } {
  const config = loadConfig();
  if (!config.hosts[name]) return { removed: false };
  if (name === CLOUD_HOST_NAME) {
    config.hosts[name] = defaultHost(DEFAULT_API_BASE);
  } else if (name === LOCAL_DEV_HOST_NAME) {
    config.hosts[name] = defaultHost(DEFAULT_LOCAL_DEV_API_BASE);
  } else if (name === INTERNAL_DEV_HOST_NAME) {
    config.hosts[name] = defaultHost(DEFAULT_INTERNAL_DEV_API_BASE);
  } else if (name === SELFHOST_HOST_NAME) {
    config.hosts[name] = defaultHost(DEFAULT_SELFHOST_API_BASE);
  } else {
    delete config.hosts[name];
  }
  let switchedTo: string | undefined;
  if (config.active === name) {
    const remaining = Object.keys(config.hosts).sort();
    config.active = remaining[0] ?? DEFAULT_HOST_NAME;
    if (remaining.length > 0) switchedTo = config.active;
  }
  saveConfig(config);
  return { removed: true, switchedTo };
}

export function useHost(name: string): boolean {
  const config = loadConfig();
  if (!config.hosts[name]) return false;
  config.active = name;
  saveConfig(config);
  return true;
}

// ─── Validation ───────────────────────────────────────────────────────────

const VALID_HOST_NAME = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

export function validateHostName(name: string): void {
  if (!VALID_HOST_NAME.test(name) || name.length > 64) {
    throw new Error(
      `invalid host name "${name}" — letters/digits/._-, must start with a letter, max 64 chars`,
    );
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────

/** Loopback, RFC1918, link-local, and CGNAT IPv4 ranges. */
function isPrivateIPv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  return (
    a === 0 || // unspecified 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
  );
}

/** Loopback, unspecified, unique-local, link-local, and mapped private IPv4. */
function isPrivateIPv6(host: string): boolean {
  if (host === '::' || host === '::1') return true;

  // WHATWG URL parsing canonicalizes `::ffff:192.168.1.50` to
  // `::ffff:c0a8:132`. Recover the mapped IPv4 before applying its ranges.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mapped) {
    const value = Number.parseInt(mapped[1], 16) * 0x10000 + Number.parseInt(mapped[2], 16);
    const ipv4 = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ].join('.');
    return isPrivateIPv4(ipv4);
  }

  const firstHextet = Number.parseInt(host.split(':', 1)[0], 16);
  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) || // fc00::/7 unique-local
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) // fe80::/10 link-local
  );
}

/**
 * Is this host unreachable from the public internet — i.e. somewhere plain
 * `http` is the legitimate, intended scheme?
 *
 * Loopback is the obvious case, but a self-host reaches its own API over any of:
 *   - a container/service name on a private network — `http://kortix-api:8000`
 *     (single-label: a public FQDN always has a dot)
 *   - a LAN or VPC address — `http://192.168.1.50:8000`, `http://10.2.0.7:8000`
 *   - a private DNS suffix — `.local`, `.internal`, `.lan`, `.home.arpa`
 * None of those can present a public certificate, so upgrading them to https
 * cannot succeed — it only replaces a working request with an opaque failure.
 */
function isPrivateHostname(rawHost: string): boolean {
  const host = rawHost
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const ipFamily = isIP(host);
  if (ipFamily === 4) return isPrivateIPv4(host);
  if (ipFamily === 6) return isPrivateIPv6(host);
  if (host === 'localhost') return true;

  // A non-IP name without a dot is a container/service name, not a public FQDN.
  if (!host.includes('.')) return true;
  return (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  );
}

/**
 * Kortix cloud APIs are HTTPS-only. A remote `http://` base 308-redirects to
 * https, and `fetch` drops the `Authorization` header on the scheme change — so
 * the bearer token silently never arrives and the call 401s as "Token rejected
 * by the API" even after a successful browser login (and the same drop breaks
 * the sandbox proxy, which reads the stored base directly). Upgrade any REMOTE
 * http base to https; localhost / self-host (legitimately plain http) stay put.
 *
 * "Self-host" is why the predicate is `isPrivateHostname` and not just
 * loopback: a compose deployment talks to its API as `http://kortix-api:8000`
 * or `http://192.168.x.y:8000`, and forcing https there turns a working
 * cleartext request into a TLS handshake against a non-TLS port — which
 * surfaces only as an unexplained "Unable to connect", with no hint that the
 * CLI rewrote the scheme.
 */
export function secureRemoteBase(base: string): string {
  try {
    const u = new URL(base);
    if (u.protocol === 'http:' && !isPrivateHostname(u.hostname)) {
      u.protocol = 'https:';
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    // Not a parseable absolute URL — leave it for the caller/fetch to reject.
  }
  return base;
}

function normalizeConfig(parsed: Partial<Config>): Config {
  const hosts = parsed.hosts ?? {};
  const cleaned: Record<string, Host> = {};
  for (const [name, value] of Object.entries(hosts)) {
    if (!value || typeof value !== 'object') continue;
    const h = value as Partial<Host>;
    if (typeof h.token !== 'string') continue;
    const migratedDefault = isDefaultWorkspaceRef(h.default_workspace)
      ? h.default_workspace
      : isDefaultProjectRef(h.default_project)
        ? {
            workspace_id: h.default_project.project_id,
            account_id: h.default_project.account_id,
            ...(h.default_project.name ? { name: h.default_project.name } : {}),
          }
        : undefined;
    cleaned[name] = {
      url: secureRemoteBase(h.url ?? DEFAULT_API_BASE),
      token: h.token,
      user_id: h.user_id ?? '',
      user_email: h.user_email ?? '',
      account_id: h.account_id ?? '',
      logged_in_at: h.logged_in_at ?? new Date().toISOString(),
      // New optional fields — carried through verbatim when present so an
      // older config (without them) still loads, and a newer one round-trips.
      ...(typeof h.account_slug === 'string' ? { account_slug: h.account_slug } : {}),
      ...(typeof h.account_name === 'string' ? { account_name: h.account_name } : {}),
      ...(migratedDefault ? { default_workspace: migratedDefault } : {}),
      ...(typeof h.dashboard_url === 'string' ? { dashboard_url: h.dashboard_url } : {}),
    };
  }
  // Tracks which old names were folded into new ones so we can retarget the
  // active host below (e.g. active "dev" → "local-dev").
  const renamed: Record<string, string> = {};

  // Legacy `default`: the original single-host name. If it still points at
  // Kortix Cloud, fold it into `cloud`. If it is a never-logged-in placeholder
  // (no token), it is a stale artifact — drop it and fall back to cloud. A
  // `default` host that actually carries credentials is left untouched.
  const legacyDefault = cleaned.default;
  if (legacyDefault) {
    if (!cleaned[CLOUD_HOST_NAME] && legacyDefault.url === DEFAULT_API_BASE) {
      cleaned[CLOUD_HOST_NAME] = legacyDefault;
      delete cleaned.default;
      renamed.default = CLOUD_HOST_NAME;
    } else if (!legacyDefault.token) {
      delete cleaned.default;
      renamed.default = CLOUD_HOST_NAME;
    }
  }

  // Legacy `dev` (localhost:8008) → `local-dev`. `dev` was always the local
  // dev server, so carry its credentials over wholesale.
  if (cleaned[LEGACY_DEV_HOST_NAME] && !cleaned[LOCAL_DEV_HOST_NAME]) {
    cleaned[LOCAL_DEV_HOST_NAME] = cleaned[LEGACY_DEV_HOST_NAME];
    delete cleaned[LEGACY_DEV_HOST_NAME];
    renamed[LEGACY_DEV_HOST_NAME] = LOCAL_DEV_HOST_NAME;
  }

  // Legacy `local` (the old self-host default, localhost:13738) → `selfhost`.
  // Only migrate when it still carries the old default URL; a user who pointed
  // `local` somewhere else keeps it as a regular custom host.
  const legacyLocal = cleaned[LEGACY_LOCAL_HOST_NAME];
  if (legacyLocal && legacyLocal.url === LEGACY_LOCAL_API_BASE && !cleaned[SELFHOST_HOST_NAME]) {
    cleaned[SELFHOST_HOST_NAME] = legacyLocal;
    delete cleaned[LEGACY_LOCAL_HOST_NAME];
    renamed[LEGACY_LOCAL_HOST_NAME] = SELFHOST_HOST_NAME;
  }

  // Seed any missing built-ins.
  if (!cleaned[CLOUD_HOST_NAME]) {
    cleaned[CLOUD_HOST_NAME] = defaultHost(DEFAULT_API_BASE);
  }
  if (!cleaned[LOCAL_DEV_HOST_NAME]) {
    cleaned[LOCAL_DEV_HOST_NAME] = defaultHost(DEFAULT_LOCAL_DEV_API_BASE);
  }
  if (!cleaned[INTERNAL_DEV_HOST_NAME]) {
    cleaned[INTERNAL_DEV_HOST_NAME] = defaultHost(DEFAULT_INTERNAL_DEV_API_BASE);
  }
  if (!cleaned[SELFHOST_HOST_NAME]) {
    cleaned[SELFHOST_HOST_NAME] = defaultHost(DEFAULT_SELFHOST_API_BASE);
  }

  let active = parsed.active ?? DEFAULT_HOST_NAME;
  if (renamed[active]) active = renamed[active];
  if (!cleaned[active]) {
    active = cleaned[DEFAULT_HOST_NAME] ? DEFAULT_HOST_NAME : Object.keys(cleaned)[0]!;
  }
  return { active, hosts: cleaned };
}

function isDefaultProjectRef(value: unknown): value is DefaultProjectRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.project_id === 'string' && typeof v.account_id === 'string';
}

function isDefaultWorkspaceRef(value: unknown): value is DefaultWorkspaceRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.workspace_id === 'string' && typeof v.account_id === 'string';
}

function defaultHost(url: string): Host {
  return {
    url,
    token: '',
    user_id: '',
    user_email: '',
    account_id: '',
    logged_in_at: '',
  };
}

function importSingleHostAuth(
  parsed: Record<string, unknown> | Partial<Config> | null,
): Config | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const token = typeof p.token === 'string' ? p.token : undefined;
  if (!token) return null;
  // Single-host auth uses `api_base`; multi-host config uses `url`.
  const url = typeof p.api_base === 'string' ? p.api_base : DEFAULT_API_BASE;
  const host: Host = {
    url,
    token,
    user_id: typeof p.user_id === 'string' ? p.user_id : '',
    user_email: typeof p.user_email === 'string' ? p.user_email : '',
    account_id: typeof p.account_id === 'string' ? p.account_id : '',
    logged_in_at: typeof p.logged_in_at === 'string' ? p.logged_in_at : new Date().toISOString(),
  };
  return {
    active: CLOUD_HOST_NAME,
    hosts: {
      [CLOUD_HOST_NAME]: host,
      [LOCAL_DEV_HOST_NAME]: defaultHost(DEFAULT_LOCAL_DEV_API_BASE),
      [INTERNAL_DEV_HOST_NAME]: defaultHost(DEFAULT_INTERNAL_DEV_API_BASE),
      [SELFHOST_HOST_NAME]: defaultHost(DEFAULT_SELFHOST_API_BASE),
    },
  };
}
