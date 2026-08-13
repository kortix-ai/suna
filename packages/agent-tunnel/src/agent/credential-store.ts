import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const CONFIG_DIR = join(homedir(), '.agent-tunnel');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** Fields that identify a pairing. Everything else in the file is user settings. */
const PAIRING_FIELDS = ['token', 'tunnelId', 'enabledCapabilities'] as const;

function readConfigFile(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Replaces the config file atomically, private-by-default.
 *
 * Both writers need identical tmp-write/rename/chmod handling; duplicating it
 * once already meant two places to get the permission bits right.
 */
function writeConfigFileAtomic(next: Record<string, unknown>): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(CONFIG_DIR, 0o700); } catch {}

  const tmpFile = join(CONFIG_DIR, `config.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpFile, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
  try { chmodSync(tmpFile, 0o600); } catch {}
  renameSync(tmpFile, CONFIG_FILE);
  try { chmodSync(CONFIG_FILE, 0o600); } catch {}
}

export function saveCredentials(
  tunnelId: string,
  token: string,
  apiUrl: string,
  enabledCapabilities?: string[],
): void {
  writeConfigFileAtomic({
    ...readConfigFile(),
    tunnelId,
    token,
    apiUrl,
    ...(enabledCapabilities !== undefined ? { enabledCapabilities } : {}),
  });
}

/**
 * Drops only the pairing fields, so user-tuned settings such as `allowedPaths`
 * survive a re-pair. Returns true when a credential was actually present.
 */
export function clearSavedCredentials(): boolean {
  if (!existsSync(CONFIG_FILE)) return false;

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Unparseable file: there is nothing worth preserving.
    rmSync(CONFIG_FILE, { force: true });
    return true;
  }

  const hadCredentials = PAIRING_FIELDS.some((key) => key in existing && existing[key] != null);
  for (const key of PAIRING_FIELDS) delete existing[key];
  writeConfigFileAtomic(existing);
  return hadCredentials;
}
