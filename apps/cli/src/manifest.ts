import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ENV_NAME_RE } from '@kortix/manifest-schema';

/** The `[env]` contract from kortix.toml — names the runtime needs. */
export interface EnvSpec {
  required: string[];
  optional: string[];
}

export interface LocalManifest {
  /** Absolute path to the kortix.toml we read. */
  path: string;
  raw: string;
  data: Record<string, unknown>;
  env: EnvSpec;
}

/**
 * Normalize an env-name array the way the backend does (projects/git.ts
 * `asStringArray`): uppercase, validate, dedupe, drop anything that isn't a
 * legal env var name. Keeps the CLI's view of required/optional in lock-step
 * with what the server will actually enforce.
 */
function normalizeEnvNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toUpperCase();
    if (!ENV_NAME_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function envSpecFromManifest(data: Record<string, unknown>): EnvSpec {
  const env = data.env && typeof data.env === 'object' ? (data.env as Record<string, unknown>) : {};
  return {
    required: normalizeEnvNames(env.required),
    optional: normalizeEnvNames(env.optional),
  };
}

function manifestPath(cwd: string = process.cwd()): string {
  return resolve(cwd, 'kortix.toml');
}

/**
 * Parse the local kortix.toml. Returns null when there's no manifest (a
 * project may be `.kortix/`-only). Throws smol-toml's `TomlError` on a syntax
 * error — callers surface that as the "does it compile" failure.
 */
export function loadLocalManifest(cwd: string = process.cwd()): LocalManifest | null {
  const path = manifestPath(cwd);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const data = parseToml(raw) as Record<string, unknown>;
  return { path, raw, data, env: envSpecFromManifest(data) };
}
