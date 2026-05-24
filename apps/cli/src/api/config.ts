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

// ─────────────────────────────────────────────────────────────────────────────
// Multi-host config storage.
//
// File layout: ~/.config/kortix/config.json (mode 0600)
//
//   {
//     "active": "default",
//     "hosts": {
//       "default": {
//         "url": "https://api.kortix.com",
//         "token": "kortix_pat_...",
//         "user_id": "...",
//         "user_email": "...",
//         "account_id": "...",
//         "logged_in_at": "2026-05-19T..."
//       },
//       "local": { ... }
//     }
//   }
//
// One host is "active" at a time — every command operates against it
// unless overridden by `--host <name>` for a single invocation.
//
// Single-host auth files are read on first load and moved into a `default`
// host so users can switch cleanly between Kortix Cloud and self-hosted APIs.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_API_BASE = 'https://api.kortix.com';
export const DEFAULT_HOST_NAME = 'default';

export interface Host {
  url: string;
  token: string;
  user_id: string;
  user_email: string;
  account_id: string;
  logged_in_at: string;
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

  return { active: DEFAULT_HOST_NAME, hosts: {} };
}

export function saveConfig(config: Config): void {
  const path = configFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
  try {
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
 *   1. KORTIX_CLI_TOKEN env var (synthetic ephemeral host, never persisted)
 *   2. `--host` flag (handled at the call site via `getHost(name)`)
 *   3. The `active` host in config.json
 */
export function activeHost(): Host | null {
  const envToken = process.env.KORTIX_CLI_TOKEN;
  if (envToken) {
    return {
      url: process.env.KORTIX_API_URL ?? DEFAULT_API_BASE,
      token: envToken,
      user_id: '',
      user_email: '',
      account_id: '',
      logged_in_at: new Date().toISOString(),
    };
  }
  const config = loadConfig();
  const host = config.hosts[config.active];
  return host ?? null;
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

export function activeHostName(): string | null {
  const config = loadConfig();
  return config.hosts[config.active] ? config.active : null;
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
  delete config.hosts[name];
  let switchedTo: string | undefined;
  if (config.active === name) {
    const remaining = Object.keys(config.hosts).sort();
    config.active = remaining[0] ?? DEFAULT_HOST_NAME;
    if (remaining.length > 0) switchedTo = config.active;
  }
  // If there are no hosts left, remove the file entirely — leaving an
  // empty `{active, hosts: {}}` shell behind is just clutter.
  if (Object.keys(config.hosts).length === 0) {
    deleteConfig();
  } else {
    saveConfig(config);
  }
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
    };
  }
  let active = parsed.active && cleaned[parsed.active] ? parsed.active : DEFAULT_HOST_NAME;
  if (!cleaned[active]) {
    const names = Object.keys(cleaned);
    if (names.length > 0) active = names[0]!;
  }
  return { active, hosts: cleaned };
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
  return { active: DEFAULT_HOST_NAME, hosts: { [DEFAULT_HOST_NAME]: host } };
}
