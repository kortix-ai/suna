/**
 * The TUI's own settings: `tui.json` beside the CLI's `config.json`
 * (`~/.config/kortix/`, or the directory of `KORTIX_CONFIG_FILE`).
 *
 * Today it holds one choice: whether the sidebar is shown. The TUI is
 * session-first, so the sidebar starts hidden; `/sidebar` (or `Alt+B`) flips
 * it and the flip is remembered here. A flag (`--sidebar`, `--no-sidebar`)
 * outranks the file for that one run.
 *
 * Reads never throw: a missing or corrupt file is the defaults. Writes are
 * best-effort: a read-only home must not crash the app over a UI preference.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TuiPrefs {
  sidebar: boolean;
}

export const DEFAULT_PREFS: TuiPrefs = { sidebar: false };

export function prefsPath(env: Record<string, string | undefined> = process.env): string {
  const config = env.KORTIX_CONFIG_FILE ?? env.KORTIX_AUTH_FILE;
  if (config) return join(dirname(config), 'tui.json');
  return join(homedir(), '.config', 'kortix', 'tui.json');
}

export function readPrefs(path: string = prefsPath()): TuiPrefs {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiPrefs>;
    return { sidebar: typeof parsed.sidebar === 'boolean' ? parsed.sidebar : DEFAULT_PREFS.sidebar };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Merge `patch` into the file. Returns false when the write failed. */
export function writePrefs(patch: Partial<TuiPrefs>, path: string = prefsPath()): boolean {
  try {
    const next = { ...readPrefs(path), ...patch };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the sidebar starts shown. `KORTIX_TUI_SIDEBAR=1|0` (what
 * `--sidebar` / `--no-sidebar` set) wins; otherwise the saved choice.
 */
export function initialSidebarShown(
  env: Record<string, string | undefined> = process.env,
  prefs: TuiPrefs = readPrefs(prefsPath(env)),
): boolean {
  if (env.KORTIX_TUI_SIDEBAR === '1') return true;
  if (env.KORTIX_TUI_SIDEBAR === '0') return false;
  return prefs.sidebar;
}
