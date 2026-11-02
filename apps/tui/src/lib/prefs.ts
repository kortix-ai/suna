/**
 * The TUI's own settings: `tui.json` beside the CLI's `config.json`
 * (`~/.config/kortix/`, or the directory of `KORTIX_CONFIG_FILE`).
 *
 * It holds the layout (`layout/ui-prefs.ts`: which modules draw and where)
 * and whether the first-run layout picker has been answered. `/ui` and the
 * module commands (`/sidebar`, `/info`, …) write it; a flag (`--sidebar`,
 * `--no-sidebar`) outranks it for one run. The old file shape,
 * `{ "sidebar": true }`, still reads.
 *
 * Reads never throw: a missing or corrupt file is the defaults. Writes are
 * best-effort: a read-only home must not crash the app over a UI preference.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_UI, type UiPrefs, normalizeUi } from '../layout/ui-prefs.ts';

export interface TuiPrefs {
  ui: UiPrefs;
  /** The first-run layout picker was answered (or dismissed). */
  onboarded: boolean;
}

export const DEFAULT_PREFS: TuiPrefs = { ui: DEFAULT_UI, onboarded: false };

export function prefsPath(env: Record<string, string | undefined> = process.env): string {
  const config = env.KORTIX_CONFIG_FILE ?? env.KORTIX_AUTH_FILE;
  if (config) return join(dirname(config), 'tui.json');
  return join(homedir(), '.config', 'kortix', 'tui.json');
}

export function readPrefs(path: string = prefsPath()): TuiPrefs {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const legacy = typeof parsed.sidebar === 'boolean' ? parsed.sidebar : undefined;
    return {
      ui: normalizeUi(parsed.ui, legacy),
      onboarded: parsed.onboarded === true,
    };
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
 * The layout this run starts with: the saved one, with
 * `KORTIX_TUI_SIDEBAR=1|0` (what `--sidebar` / `--no-sidebar` set) applied
 * on top for this run only.
 */
export function initialUi(
  env: Record<string, string | undefined> = process.env,
  prefs: TuiPrefs = readPrefs(prefsPath(env)),
): UiPrefs {
  const ui = prefs.ui;
  if (env.KORTIX_TUI_SIDEBAR === '1') return { ...ui, sidebar: { ...ui.sidebar, on: true } };
  if (env.KORTIX_TUI_SIDEBAR === '0') return { ...ui, sidebar: { ...ui.sidebar, on: false } };
  return ui;
}
