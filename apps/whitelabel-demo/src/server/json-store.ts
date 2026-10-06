/**
 * The wrapper's two gitignored JSON stores (`users.json`, `runtime-access.json`)
 * share one shape: read a whole object from a file, fall back to `fallback` on
 * absence or a parse error, and write it back pretty-printed, creating the
 * directory when missing. This module is that shape — the stores keep only
 * their domain logic.
 *
 * Intentionally file-backed and synchronous: a reference demo for a single
 * Node process, not a production multi-instance deployment. A real deployment
 * would swap this for a real table without touching any caller.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// LUMEN_DATA_DIR override exists so the e2e suite can point a test instance at
// a throwaway temp dir — without it, tests booting `next start` from the app
// dir share (and would wipe) the developer's real local store.
export const WRAPPER_DATA_DIR =
  process.env.LUMEN_DATA_DIR || path.join(process.cwd(), '.lumen-data');

/** Read one JSON store file; any absence or parse failure is `fallback`. */
export function readJsonStore<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Write one JSON store file, creating `dir` when missing. */
export function writeJsonStore(dir: string, file: string, data: unknown): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
