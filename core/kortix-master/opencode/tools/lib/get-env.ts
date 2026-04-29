import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

const S6_ENV_DIR =
  process.env.S6_ENV_DIR || "/run/s6/container_environment";

/**
 * Parsed .env file cache.
 * Loaded once on first miss, never re-read (process lifetime).
 */
let dotenvCache: Record<string, string> | null = null;

/**
 * Walk up from multiple starting points to find the nearest .env file.
 * Tries both __dirname-based path and process.cwd() to handle bundled
 * and native execution contexts.
 */
function findDotenvPath(): string | null {
  // Try multiple starting points — __dirname may differ when bundled
  const startDirs = [
    dirname(dirname(__dirname)),  // tools/lib/ → tools/ → OpenCode config dir
    process.cwd(),                // wherever OpenCode was started from
  ];

  for (const start of startDirs) {
    let dir = start;
    for (let i = 0; i < 5; i++) {
      const candidate = resolve(dir, ".env");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  }
  return null;
}

/**
 * Parse a .env file into a key→value map.
 * Supports KEY=VALUE, ignores comments (#) and blank lines.
 * Does NOT handle multi-line values or quoted values with newlines.
 */
function parseDotenv(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && value) result[key] = value;
    }
  } catch {
    // File unreadable — return empty
  }
  return result;
}

/**
 * Load the .env cache (once per process).
 */
function getDotenv(): Record<string, string> {
  if (dotenvCache !== null) return dotenvCache;
  const path = findDotenvPath();
  dotenvCache = path ? parseDotenv(path) : {};
  return dotenvCache;
}

/**
 * Read an environment variable with multi-tier fallback.
 *
 * Resolution order (first non-empty wins):
 *
 * 1. s6 env dir file     — `/run/s6/container_environment/{key}` (always fresh, ~1μs tmpfs read)
 * 2. `process.env[key]`  — Docker env, manually exported (native dev without s6)
 * 3. `.env` file          — nearest `.env` walking up from the OpenCode config dir (native dev fallback)
 *
 * s6 is checked first so that env var updates from the secrets manager
 * (kortix-master /env API) take effect immediately — no service restart needed.
 * In native dev (no s6 dir), the read throws and falls through to process.env.
 */
export function getEnv(key: string): string | undefined {
  // 1. s6 env dir — authoritative in containers, always fresh from disk.
  //    kortix-master writes here on every /env POST, so values update without restart.
  //    tmpfs read is ~1μs — negligible cost for always-correct values.
  //    If the file exists, its value is authoritative — even if empty (meaning
  //    the key was explicitly cleared). Never fall through to stale process.env.
  try {
    const val = readFileSync(`${S6_ENV_DIR}/${key}`, "utf-8").trim();
    return val || undefined;
  } catch {
    // File doesn't exist — not in a container, or key not set via s6.
  }

  // 2. process.env — Docker env vars, shell exports (native dev without s6)
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;

  // 3. .env file fallback (native dev on macOS — no Docker, no s6)
  const dotenv = getDotenv();
  const envVal = dotenv[key];
  if (envVal) return envVal;

  return undefined;
}
