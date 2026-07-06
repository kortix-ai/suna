import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ENV_NAME_RE,
  type ManifestFormat,
  type ManifestIssue,
  manifestCandidatePaths,
  parseManifestText,
  validateManifest,
} from '@kortix/manifest-schema';

/** The `[env]` contract from the manifest — names the runtime needs. */
export interface EnvSpec {
  required: string[];
  optional: string[];
}

export interface LocalManifest {
  /** Absolute path to the manifest we read (kortix.yaml or kortix.toml). */
  path: string;
  /** The on-disk format — toml or yaml. */
  format: ManifestFormat;
  raw: string;
  data: Record<string, unknown>;
  env: EnvSpec;
}

/** Result of `verifyManifest` — hard errors block a ship, warnings don't. */
export interface ManifestIssues {
  errors: string[];
  warnings: string[];
  /** Structured issues from the canonical validator. */
  raw: ManifestIssue[];
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

export function envSpecFromManifest(data: Record<string, unknown>): EnvSpec {
  const env = data.env && typeof data.env === 'object' ? (data.env as Record<string, unknown>) : {};
  return {
    required: normalizeEnvNames(env.required),
    optional: normalizeEnvNames(env.optional),
  };
}

/**
 * Resolve the on-disk manifest, preferring `kortix.yaml` over `kortix.toml`
 * (the dual-format rule). Returns the first candidate that exists, or null when
 * the repo has no manifest.
 */
export function resolveLocalManifest(
  cwd: string = process.cwd(),
): { path: string; format: ManifestFormat } | null {
  for (const cand of manifestCandidatePaths()) {
    const abs = resolve(cwd, cand.path);
    if (existsSync(abs)) return { path: abs, format: cand.format };
  }
  return null;
}

/** Absolute path of the manifest — the existing file if any, else the canonical
 *  `kortix.toml` (used for "where to write / look" messages when none exists). */
export function manifestPath(cwd: string = process.cwd()): string {
  return resolveLocalManifest(cwd)?.path ?? resolve(cwd, 'kortix.toml');
}

/**
 * Parse the local manifest (kortix.yaml or kortix.toml). Returns null when
 * there's no manifest (a project may be `.kortix/`-only). Throws the parser's
 * syntax error — callers surface that as the "does it compile" failure.
 */
export function loadLocalManifest(cwd: string = process.cwd()): LocalManifest | null {
  const resolved = resolveLocalManifest(cwd);
  if (!resolved) return null;
  const raw = readFileSync(resolved.path, 'utf8');
  const data = parseManifestText(raw, resolved.format);
  return {
    path: resolved.path,
    format: resolved.format,
    raw,
    data,
    env: envSpecFromManifest(data),
  };
}

/**
 * Static-validate a parsed manifest the way the backend would. Thin shim
 * over `@kortix/manifest-schema/validateManifest` — kept as the legacy entry
 * point for callers that already had a parsed object handy. The canonical
 * schema covers every section (project, env, opencode, sandboxes, triggers,
 * connectors, channels, apps).
 */
export function lintManifest(data: Record<string, unknown>): ManifestIssues {
  const { issues } = validateManifest(data);
  return classifyIssues(issues);
}

/**
 * Validate a manifest from raw text. Returns a syntax-error issue when it
 * doesn't parse; otherwise runs the canonical schema. Pass the `format` so a
 * `kortix.yaml` is parsed as YAML (defaults to TOML for back-compat).
 */
export function lintManifestText(raw: string, format: ManifestFormat = 'toml'): ManifestIssues {
  const { issues } = validateManifest(raw, format);
  return classifyIssues(issues);
}

function classifyIssues(issues: ManifestIssue[]): ManifestIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const issue of issues) {
    const formatted = `${issue.path}: ${issue.message}`;
    if (issue.severity === 'error') errors.push(formatted);
    else warnings.push(formatted);
  }
  return { errors, warnings, raw: issues };
}
