import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

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

/** Result of `verifyManifest` — hard errors block a ship, warnings don't. */
export interface ManifestIssues {
  errors: string[];
  warnings: string[];
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
// Mirrors the backend's trigger slug rule (projects/triggers.ts).
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

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

export function envSpecFromManifest(data: Record<string, unknown>): EnvSpec {
  const env = data.env && typeof data.env === 'object' ? (data.env as Record<string, unknown>) : {};
  return {
    required: normalizeEnvNames(env.required),
    optional: normalizeEnvNames(env.optional),
  };
}

export function manifestPath(cwd: string = process.cwd()): string {
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

/**
 * Static-validate a parsed manifest the way the backend would, so a bad
 * config surfaces locally *before* we push. Mirrors the high-signal rules
 * that would otherwise make a project fail to load (env shapes, trigger
 * slugs/types/required fields). Returns hard `errors` (block the ship) and
 * advisory `warnings`.
 */
export function lintManifest(data: Record<string, unknown>): ManifestIssues {
  const errors: string[] = [];
  const warnings: string[] = [];

  // kortix_version — advisory; the platform pins the schema here.
  if (data.kortix_version == null) {
    warnings.push('kortix_version is not set — add `kortix_version = 1`.');
  } else if (typeof data.kortix_version !== 'number') {
    errors.push('kortix_version must be a number.');
  }

  // [env] — required/optional must be string arrays of valid env names.
  if (data.env != null) {
    if (typeof data.env !== 'object' || Array.isArray(data.env)) {
      errors.push('[env] must be a table.');
    } else {
      const env = data.env as Record<string, unknown>;
      for (const key of ['required', 'optional'] as const) {
        const val = env[key];
        if (val == null) continue;
        if (!Array.isArray(val)) {
          errors.push(`[env] ${key} must be an array of strings.`);
          continue;
        }
        for (const item of val) {
          if (typeof item !== 'string') {
            errors.push(`[env] ${key} contains a non-string entry.`);
          } else if (!ENV_NAME_RE.test(item.trim().toUpperCase())) {
            errors.push(`[env] ${key}: "${item}" is not a valid env var name (A-Z, 0-9, _).`);
          }
        }
      }
    }
  }

  // [[triggers]] — same rules the server enforces in projects/triggers.ts.
  if (data.triggers != null) {
    if (!Array.isArray(data.triggers)) {
      errors.push('[[triggers]] must be an array of tables.');
    } else {
      const seenSlugs = new Set<string>();
      data.triggers.forEach((entry, i) => {
        const where = `[[triggers]] #${i + 1}`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`${where} is not a table.`);
          return;
        }
        const row = entry as Record<string, unknown>;
        const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
        const label = slug ? `trigger "${slug}"` : where;
        if (!slug) {
          errors.push(`${where} is missing a slug.`);
        } else if (!SLUG_RE.test(slug)) {
          errors.push(`${label}: invalid slug — lowercase letters, digits, dashes, underscores only.`);
        } else if (seenSlugs.has(slug)) {
          errors.push(`${label}: duplicate slug — slugs must be unique per project.`);
        } else {
          seenSlugs.add(slug);
        }

        const type = typeof row.type === 'string' ? row.type.trim() : '';
        if (type !== 'cron' && type !== 'webhook') {
          errors.push(`${label}: type must be "cron" or "webhook" (got "${type || 'unset'}").`);
        }
        const prompt =
          typeof row.prompt === 'string'
            ? row.prompt
            : typeof row.prompt_template === 'string'
              ? row.prompt_template
              : '';
        if (!prompt.trim()) errors.push(`${label}: prompt is required and may not be empty.`);

        if (type === 'cron') {
          const cron =
            typeof row.cron === 'string'
              ? row.cron.trim()
              : typeof row.schedule === 'string'
                ? row.schedule.trim()
                : '';
          if (!cron) errors.push(`${label}: cron triggers must declare a \`cron\` expression.`);
        } else if (type === 'webhook') {
          const secretEnv =
            typeof row.secret_env === 'string'
              ? row.secret_env.trim()
              : typeof row.secretEnv === 'string'
                ? row.secretEnv.trim()
                : '';
          if (!secretEnv) {
            errors.push(`${label}: webhook triggers must declare a \`secret_env\`.`);
          } else if (!ENV_NAME_RE.test(secretEnv)) {
            errors.push(`${label}: secret_env "${secretEnv}" is not a valid env var name.`);
          }
        }
      });
    }
  }

  return { errors, warnings };
}
