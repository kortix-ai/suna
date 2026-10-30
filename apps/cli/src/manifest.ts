import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  ENV_NAME_RE,
  deprecationIssues,
  type ManifestIssue,
  ManifestImportError,
  type ResolvedManifest,
  hasManifestImports,
  legacyFormatMessage,
  locateIssues,
  manifestCandidatePaths,
  validateManifest,
} from '@kortix/manifest-schema';
import { resolveLocalManifestImports } from './manifest-imports.ts';
import { convertLocalLegacy, localLegacyManifest, readLegacyManifest } from './manifest-legacy.ts';
import { type ProjectIssue, lintProject } from './project-lint.ts';
import { C } from './style.ts';

/** The `[env]` contract from the manifest — names the runtime needs. */
export interface EnvSpec {
  required: string[];
  optional: string[];
}

export interface LocalManifest {
  /** Absolute path to the manifest we read (kortix.yaml or kortix.yml). */
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

export function envSpecFromManifest(data: Record<string, unknown>): EnvSpec {
  const env = data.env && typeof data.env === 'object' ? (data.env as Record<string, unknown>) : {};
  return {
    required: normalizeEnvNames(env.required),
    optional: normalizeEnvNames(env.optional),
  };
}

/**
 * Resolve the on-disk manifest: `kortix.yaml`, else `kortix.yml`. Returns null
 * when the repo has no manifest.
 */
export function resolveLocalManifest(cwd: string = process.cwd()): { path: string } | null {
  for (const candidate of manifestCandidatePaths()) {
    const abs = resolve(cwd, candidate);
    if (existsSync(abs)) return { path: abs };
  }
  return null;
}

/** Absolute path of the manifest — the existing file if any, else the canonical
 *  `kortix.yaml` (used for "where to write / look" messages when none exists). */
export function manifestPath(cwd: string = process.cwd()): string {
  return resolveLocalManifest(cwd)?.path ?? resolve(cwd, 'kortix.yaml');
}

/**
 * Parse the local manifest (kortix.yaml or kortix.yml). Returns null when
 * there's no manifest (a project may be `.kortix/`-only). Throws the parser's
 * syntax error — callers surface that as the "does it compile" failure.
 */
export function loadLocalManifest(cwd: string = process.cwd()): LocalManifest | null {
  // A legacy format (`kortix_version` 1 or 2, or `kortix.toml`) reads as the latest shape, as the platform runs it.
  const legacy = localLegacyManifest(cwd);
  if (legacy) {
    const data = convertLocalLegacy(cwd, legacy).raw;
    return { path: legacy.path, raw: readFileSync(legacy.path, 'utf8'), data, env: envSpecFromManifest(data) };
  }
  const resolved = resolveLocalManifest(cwd);
  if (!resolved) return null;
  const raw = readFileSync(resolved.path, 'utf8');
  // `data` is the MERGED document when the manifest declares `imports:` — what
  // the platform runs. `raw` stays the root file's own text.
  const data = resolveLocalManifestImports(resolved.path).raw;
  return {
    path: resolved.path,
    raw,
    data,
    env: envSpecFromManifest(data),
  };
}

/** A manifest or project issue with the absolute path of the file that holds it. */
export interface FileIssue extends ManifestIssue {
  file: string;
}

/**
 * The `kortix validate` checks for the manifest at `path`: the schema over the
 * document the platform runs (`imports:` merged), then the project checks
 * (`lintProject`). Each issue names the file that declares the entry, with the
 * line and column `locateIssues` finds there. `parsed` is null on a YAML
 * syntax error.
 */
export function validateManifestFile(
  path: string,
  opts: { dockerfileLint?: boolean } = {},
): { parsed: Record<string, unknown> | null; issues: FileIssue[] } {
  const text = readFileSync(path, 'utf8');
  if (/\.toml$/i.test(path) || /^kortix_version\s*:/m.test(text)) {
    const legacy = validateLegacyManifestFile(path, text, opts);
    if (legacy) return legacy;
  }
  let { parsed, issues } = validateManifest(text);
  let resolved: ResolvedManifest | null = null;
  if (parsed && hasManifestImports(parsed)) {
    try {
      resolved = resolveLocalManifestImports(path);
      parsed = resolved.raw;
      issues = validateManifest(parsed).issues;
    } catch (err) {
      if (!(err instanceof ManifestImportError)) throw err;
      issues.push({ path: 'imports', message: err.message, severity: 'error' });
    }
  }
  const located = [...issues, ...lintProject(parsed, path, opts)].map((issue) => declaringFile(issue, path, resolved));
  // The merged document is already in the latest shape: each file reports its own deprecated shapes.
  if (resolved) {
    for (const file of resolved.files) {
      const filePath = resolve(dirname(path), file.path);
      located.unshift(...deprecationIssues(filePath === path ? text : readFileSync(filePath, 'utf8')).map((issue) => ({ ...issue, file: filePath })));
    }
  }
  // One parse per file: `locateIssues` fills `line`/`column` on every issue that has none.
  // A Dockerfile issue always has its line, so its file is never read here.
  for (const file of new Set(located.map((issue) => issue.file))) {
    const inFile = located.filter((issue) => issue.file === file);
    if (inFile.some((issue) => issue.line === undefined)) locateIssues(file === path ? text : readFileSync(file, 'utf8'), inFile);
  }
  return { parsed, issues: located };
}

/**
 * `kortix validate` for a legacy file (`kortix_version` 1 or 2, or
 * `kortix.toml`): what the platform runs is the converted manifest. One
 * warning says it still works and `--fix` converts it, one per thing the
 * conversion cannot carry over, then the converted manifest's issues and the
 * project checks. The wiring check waits for `--fix`: the converted prompt
 * files exist only after it. Null when the file is not a legacy format.
 */
function validateLegacyManifestFile(
  path: string,
  text: string,
  opts: { dockerfileLint?: boolean },
): { parsed: Record<string, unknown> | null; issues: FileIssue[] } | null {
  const versionLine = text.split('\n').findIndex((line) => /^kortix_version\s*[:=]/.test(line));
  const at = versionLine >= 0 ? { line: versionLine + 1, column: 1 } : {};
  let legacy;
  try {
    legacy = readLegacyManifest(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { parsed: null, issues: [{ path: '<toml>', message: `Syntax error: ${detail}`, severity: 'error', file: path }] };
  }
  if (!legacy) return null;
  const conversion = convertLocalLegacy(dirname(path), legacy);
  const converted = validateManifest(conversion.raw).issues;
  const issues: FileIssue[] = [
    { path: 'kortix_version', message: legacyFormatMessage(legacy.from), severity: 'warning', fix: 'legacy-format', ...at, file: path },
    ...conversion.dropped.map((note) => ({ path: 'kortix_version', message: `Not carried over: ${note}`, severity: 'warning' as const, fix: 'legacy-format', ...at, file: path })),
    ...converted.map((issue) => ({ ...issue, file: path })),
    ...lintProject(conversion.raw, path, { ...opts, wiring: false }).map((issue) => ({ ...issue, file: issue.file ?? path })),
  ];
  // A YAML file keeps most of its keys: an issue points at the nearest one.
  if (legacy.from === 2) locateIssues(text, issues.filter((issue) => issue.file === path));
  return { parsed: conversion.raw, issues };
}

/**
 * The file that holds `issue`. A collection entry (`agents.<name>`,
 * `triggers[<i>]`, …) of a manifest with imports is in the file that declares
 * it, and a list entry's index becomes its index in that file. Everything else
 * is in the root manifest.
 */
function declaringFile(issue: ProjectIssue, rootPath: string, resolved: ResolvedManifest | null): FileIssue {
  const m = resolved && !issue.file ? /^([a-z_]+)(?:\.([^.[]+)|\[(\d+)\])/.exec(issue.path) : null;
  if (!resolved || !m) return { ...issue, file: issue.file ?? rootPath };
  const key = m[1]!;
  const merged = resolved.raw[key];
  const entry = m[3] !== undefined && Array.isArray(merged) ? merged[Number(m[3])] : undefined;
  // A list entry keeps its object identity through the merge; a map entry is found by its origin.
  const origin = (resolved.origins as Record<string, Record<string, string> | undefined>)[key]?.[m[2] ?? ''];
  const declaring = resolved.files.find((f) =>
    entry !== undefined ? Array.isArray(f.raw[key]) && (f.raw[key] as unknown[]).includes(entry) : f.path === origin,
  );
  if (!declaring) return { ...issue, file: rootPath };
  const path = entry === undefined ? issue.path : `${key}[${(declaring.raw[key] as unknown[]).indexOf(entry)}]${issue.path.slice(m[0].length)}`;
  return { ...issue, path, file: resolve(dirname(rootPath), declaring.path) };
}

/** One issue as `<file>:<line>:<col>  <severity>  <path>  <message>`; the file is relative to `cwd` when under it. */
export function formatIssueLine(issue: FileIssue, cwd: string = process.cwd()): string {
  const rel = relative(cwd, issue.file);
  const file = rel && !rel.startsWith('..') ? rel : issue.file;
  const at = issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ''}` : '';
  const severity = issue.severity === 'error' ? `${C.red}error${C.reset}` : `${C.yellow}warning${C.reset}`;
  return `${file}${at}  ${severity}  ${issue.path}  ${issue.message}`;
}
