import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
export const DEFAULT_INTERNAL_DEV_API_BASE = 'http://dev-api.kortix.com';
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

/** The global default project for a host — used by every project-scoped
 *  command (executor, connectors, sessions, …) when the cwd is not bound
 *  to a project via `.kortix/link.json`. Carries its account_id so the
 *  default always resolves under the right account. */
export interface DefaultProjectRef {
  project_id: string;
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
  /** Global default project for this host (see DefaultProjectRef). */
  default_project?: DefaultProjectRef;
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
  return (
    process.env.KORTIX_CONFIG_FILE ??
    process.env.KORTIX_AUTH_FILE ??
    defaultConfigPath()
  );
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
 *   1. KORTIX_CLI_TOKEN env var (synthetic ephemeral host, never persisted),
 *      falling back to KORTIX_EXECUTOR_TOKEN — both carry the session-scoped
 *      executor PAT the platform injects into a sandbox. (The SANDBOX credential
 *      — KORTIX_SANDBOX_TOKEN / its legacy KORTIX_TOKEN alias — is deliberately
 *      NOT used here: it's the daemon's identity, not the user's, and does not
 *      authenticate against the project-scoped API routes the CLI calls.)
 *   2. KORTIX_API_URL env var (URL override for the stored active host)
 *   3. `--host` flag (handled at the call site via `getHost(name)`)
 *   4. The `active` host in config.json
 */
/**
 * True when the platform-injected sandbox token (KORTIX_CLI_TOKEN /
 * KORTIX_EXECUTOR_TOKEN) is present. `activeHost()` then resolves to a
 * synthetic env host, which must outrank a `.kortix/link.json` host —
 * inside a sandbox the named host has no stored credentials, so honoring
 * the link would strand a fully-authenticated CLI on "not logged in".
 */
function sandboxCliToken(): string | undefined {
  return sandboxEnvValue('KORTIX_CLI_TOKEN') || sandboxEnvValue('KORTIX_EXECUTOR_TOKEN');
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

// ─── Active account + default project ───────────────────────────────────────

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

/** The active host's global default project, or null when none is set. */
export function defaultProject(): DefaultProjectRef | null {
  const host = activeHost();
  return host?.default_project ?? null;
}

/** Plain "Name (slug)" label, or just the slug when no name is known (a
 *  pre-name-capture login). Avoids the ugly "slug (slug)" duplication. */
export function accountLabel(a: { name?: string; slug: string }): string {
  return a.name ? `${a.name} (${a.slug})` : a.slug;
}

/** Switch the active account on a host (default: the active host). A
 *  default project that no longer lives in the active account is dropped —
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
  if (host.default_project && host.default_project.account_id !== account.id) {
    delete host.default_project;
  }
  saveConfig(config);
}

/** Set the global default project on a host (default: the active host). */
export function setDefaultProject(project: DefaultProjectRef, hostName?: string): void {
  const config = loadConfig();
  const name = resolveTargetHostName(config, hostName);
  const host = config.hosts[name];
  if (!host) return;
  host.default_project = {
    project_id: project.project_id,
    account_id: project.account_id,
    ...(project.name ? { name: project.name } : {}),
  };
  saveConfig(config);
}

/** Clear the global default project. Returns true if one was removed. */
export function clearDefaultProject(hostName?: string): boolean {
  const config = loadConfig();
  const name = resolveTargetHostName(config, hostName);
  const host = config.hosts[name];
  if (!host?.default_project) return false;
  delete host.default_project;
  saveConfig(config);
  return true;
}

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

function normalizeConfig(parsed: Partial<Config>): Config {
  const hosts = parsed.hosts ?? {};
  const cleaned: Record<string, Host> = {};
  for (const [name, value] of Object.entries(hosts)) {
    if (!value || typeof value !== 'object') continue;
    const h = value as Partial<Host>;
    if (typeof h.token !== 'string') continue;
    cleaned[name] = {
      url: h.url ?? DEFAULT_API_BASE,
      token: h.token,
      user_id: h.user_id ?? '',
      user_email: h.user_email ?? '',
      account_id: h.account_id ?? '',
      logged_in_at: h.logged_in_at ?? new Date().toISOString(),
      // New optional fields — carried through verbatim when present so an
      // older config (without them) still loads, and a newer one round-trips.
      ...(typeof h.account_slug === 'string' ? { account_slug: h.account_slug } : {}),
      ...(typeof h.account_name === 'string' ? { account_name: h.account_name } : {}),
      ...(isDefaultProjectRef(h.default_project) ? { default_project: h.default_project } : {}),
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

function importSingleHostAuth(parsed: Record<string, unknown> | Partial<Config> | null): Config | null {
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
    logged_in_at:
      typeof p.logged_in_at === 'string' ? p.logged_in_at : new Date().toISOString(),
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
