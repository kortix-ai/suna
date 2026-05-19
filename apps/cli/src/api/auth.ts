import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const DEFAULT_API_BASE = 'https://api.kortix.com';

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

function authFilePath(): string {
  if (process.env.KORTIX_AUTH_FILE) return process.env.KORTIX_AUTH_FILE;
  return resolve(homedir(), '.config', 'kortix', 'auth.json');
}

/** Read the auth file, applying KORTIX_CLI_TOKEN env override if present.
 *
 * Note: we intentionally use `KORTIX_CLI_TOKEN`, not the generic
 * `KORTIX_TOKEN`. The latter is also injected into Kortix session
 * sandboxes (as a `kortix_sb_...` key) — if a developer has that
 * value exported in their shell, we don't want this CLI to pick it
 * up by accident, because it's a sandbox key, not a CLI PAT. */
export function loadAuth(): Auth | null {
  const envToken = process.env.KORTIX_CLI_TOKEN;
  if (envToken) {
    return {
      api_base: process.env.KORTIX_API_URL ?? DEFAULT_API_BASE,
      token: envToken,
      user_id: '',
      user_email: '',
      account_id: '',
      logged_in_at: new Date().toISOString(),
    };
  }
  const path = authFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Auth>;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    return {
      api_base: parsed.api_base ?? DEFAULT_API_BASE,
      token: parsed.token,
      user_id: parsed.user_id ?? '',
      user_email: parsed.user_email ?? '',
      account_id: parsed.account_id ?? '',
      logged_in_at: parsed.logged_in_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Persist auth at ~/.config/kortix/auth.json with mode 0600. */
export function saveAuth(auth: Auth): void {
  const path = authFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(auth, null, 2) + '\n', 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on Windows */
  }
}

/** Remove the auth file. Idempotent. */
export function clearAuth(): void {
  const path = authFilePath();
  if (existsSync(path)) rmSync(path, { force: true });
}

export function authFileLocation(): string {
  return authFilePath();
}

export function resolveApiBase(): string {
  if (process.env.KORTIX_API_URL) return process.env.KORTIX_API_URL;
  const auth = loadAuth();
  return auth?.api_base ?? DEFAULT_API_BASE;
}
