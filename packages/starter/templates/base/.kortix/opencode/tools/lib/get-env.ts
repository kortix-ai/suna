import { readFileSync, existsSync, statSync } from "fs";
import { resolve, dirname } from "path";

const S6_ENV_DIR =
  process.env.S6_ENV_DIR || "/run/s6/container_environment";
const LIVE_ENV_FILES = [
  process.env.KORTIX_AGENT_ENV_FILE,
  "/dev/shm/kortix/agent-env.sh",
  "/tmp/pt-env",
  "/etc/pt-env",
].filter((path): path is string => !!path);

/**
 * Parsed .env file cache.
 * Loaded once on first miss, never re-read (process lifetime).
 */
let dotenvCache: Record<string, string> | null = null;

/**
 * Parsed live env file cache.
 * Invalidated by mtime so live session env swaps become visible without
 * restarting the OpenCode process that runs these tools.
 */
let liveEnvCache: Record<
  string,
  { mtimeMs: number; env: Record<string, string> }
> = {};

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

function unquoteEnvValue(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\$`])/g, "$1")
      .replace(/\\n/g, "\n");
  }
  return value;
}

/**
 * Parse a sourced shell env file (`export KEY='value'`) or plain KEY=VALUE file.
 */
function parseLiveEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("unset ")) {
        continue;
      }
      const body = trimmed.startsWith("export ")
        ? trimmed.slice("export ".length).trim()
        : trimmed;
      const eqIdx = body.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = body.slice(0, eqIdx).trim();
      const value = unquoteEnvValue(body.slice(eqIdx + 1).trim());
      if (key && value) result[key] = value;
    }
  } catch {
    // File unreadable — return empty
  }
  return result;
}

function getLiveEnvValue(key: string): string | undefined {
  for (const path of LIVE_ENV_FILES) {
    try {
      const stat = existsSync(path) ? statSync(path) : null;
      if (!stat) continue;
      const cached = liveEnvCache[path];
      const env =
        cached && cached.mtimeMs === stat.mtimeMs
          ? cached.env
          : parseLiveEnvFile(path);
      liveEnvCache[path] = { mtimeMs: stat.mtimeMs, env };
      if (env[key]) return env[key];
    } catch {
      // Try the next live env file.
    }
  }
  return undefined;
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
 * 3. live agent env file — `/dev/shm/kortix/agent-env.sh` or warm-claim env files
 * 4. `.env` file          — nearest `.env` walking up from the OpenCode config dir (native dev fallback)
 *
 * s6 is checked first so that env var updates from the secrets manager
 * (kortix-master /env API) take effect immediately — no service restart needed.
 * In native dev (no s6 dir), the read throws and falls through to process.env.
 */
export function getEnv(key: string): string | undefined {
  // 1. s6 env dir — authoritative in containers, always fresh from disk.
  //    kortix-master writes here on every /env POST, so values update without restart.
  //    tmpfs read is ~1μs — negligible cost for always-correct values.
  try {
    const val = readFileSync(`${S6_ENV_DIR}/${key}`, "utf-8").trim();
    if (val) return val;
  } catch {
    // File doesn't exist — not in a container, or key not set via s6.
  }

  // 2. process.env — Docker env vars, shell exports (native dev without s6)
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;

  // 3. Live agent env file — warm/hot-swapped OpenCode may keep an old process
  //    env while shells already receive the current session env through BASH_ENV.
  const liveVal = getLiveEnvValue(key);
  if (liveVal) return liveVal;

  // 4. .env file fallback (native dev on macOS — no Docker, no s6)
  const dotenv = getDotenv();
  const envVal = dotenv[key];
  if (envVal) return envVal;

  return undefined;
}

/**
 * Base URL for a Kortix router-proxied upstream service, derived from
 * KORTIX_API_URL. The sandbox only ever holds KORTIX_API_URL + KORTIX_TOKEN;
 * tools build their proxy endpoint from those two. Normalizes so it works
 * whether KORTIX_API_URL is a bare origin or already ends in /v1 or /v1/router.
 * Returns null when KORTIX_API_URL is unset.
 */
export function getKortixRouterBase(service: string): string | null {
  const raw = getEnv("KORTIX_API_URL");
  if (!raw) return null;
  const root = raw
    .replace(/\/+$/, "")
    .replace(/\/v1\/router$/, "")
    .replace(/\/v1$/, "");
  return `${root}/v1/router/${service}`;
}
