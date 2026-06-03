/**
 * `[[apps]]` parsing for `kortix.toml`.
 *
 * Each entry declares one deployable surface (fly.toml-style) — slug,
 * source, build, env, domains. The platform reads this array, dispatches
 * through the deployment provider adapter (Freestyle today; the registry
 * lives in `apps/api/src/deployments/providers/` so additional backends
 * can be plugged in without touching the manifest schema), and registers
 * a row in the `deployments` table per actual deploy.
 *
 * Example:
 *
 *   [[apps]]
 *   slug = "marketing-site"
 *   name = "Marketing site"
 *   enabled = true
 *   domains = ["marketing.style.dev"]
 *   framework = "next"
 *
 *     [apps.source]
 *     type = "git"
 *     repo = "https://github.com/me/site"
 *     branch = "main"
 *     root_path = "apps/site"
 *
 *     [apps.build]
 *     command = "pnpm build"
 *     out_dir = "dist"
 *
 *     [apps.env]
 *     NEXT_PUBLIC_API_URL = "https://api.example.com"
 *
 * Parser mirrors `projects/triggers.ts`: never throws on bad entries,
 * collects them in `errors` so the UI can render them alongside good ones.
 */
import { createHash } from 'node:crypto';
import { MANIFEST_FILENAME, readManifest, type ParsedManifest } from './triggers';
import type { GitBackedProject } from './git';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export type AppSourceSpec =
  | { type: 'git'; repo: string | null; branch: string | null; rootPath: string | null }
  | { type: 'tar'; url: string };

export interface AppBuildSpec {
  command: string | null;
  outDir: string | null;
}

export interface AppSpec {
  /** URL-safe slug — unique per project. */
  slug: string;
  /** `kortix.toml#apps.<slug>` for UI / error reporting. */
  path: string;
  /** Human label; defaults to slug. */
  name: string;
  /** When false the sweep skips this entry. */
  enabled: boolean;
  source: AppSourceSpec;
  build: AppBuildSpec | null;
  env: Record<string, string>;
  domains: string[];
  framework: string | null;
}

interface AppParseError {
  slug: string;
  path: string;
  error: string;
}

interface LoadedApps {
  specs: AppSpec[];
  errors: AppParseError[];
}

/**
 * Pull `[[apps]]` out of a parsed manifest. Never throws.
 */
export function extractApps(manifest: ParsedManifest): LoadedApps {
  const raw = manifest.raw.apps;
  if (raw === undefined || raw === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      specs: [],
      errors: [{
        slug: '(top-level)',
        path: MANIFEST_FILENAME,
        error: '`apps` must be an array of tables — use [[apps]], not [apps]',
      }],
    };
  }

  const specs: AppSpec[] = [];
  const errors: AppParseError[] = [];
  const seenSlugs = new Set<string>();

  raw.forEach((entry, index) => {
    const result = parseAppEntry(entry, index);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    if (seenSlugs.has(result.spec.slug)) {
      errors.push({
        slug: result.spec.slug,
        path: result.spec.path,
        error: `Duplicate app slug "${result.spec.slug}" — slugs must be unique within a project`,
      });
      return;
    }
    seenSlugs.add(result.spec.slug);
    specs.push(result.spec);
  });

  specs.sort((a, b) => a.slug.localeCompare(b.slug));
  errors.sort((a, b) => a.slug.localeCompare(b.slug));
  return { specs, errors };
}

/**
 * Read + parse a project's manifest, then extract `[[apps]]`. Returns
 * empty arrays + a single top-level error when the manifest fails to
 * load — never throws.
 */
export async function loadProjectApps(project: GitBackedProject): Promise<LoadedApps> {
  let manifest: ParsedManifest | null;
  try {
    manifest = await readManifest(project);
  } catch (err) {
    return {
      specs: [],
      errors: [{
        slug: '(manifest)',
        path: MANIFEST_FILENAME,
        error: (err as Error).message || 'Failed to read manifest',
      }],
    };
  }
  if (!manifest) return { specs: [], errors: [] };
  return extractApps(manifest);
}

/**
 * Convert an AppSpec back to the TOML-shaped object that lives in
 * `manifest.raw.apps`. Inverse of `parseAppEntry`. Used by the CRUD
 * path to round-trip an edit before committing.
 */
export function appSpecToTomlEntry(spec: AppSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    slug: spec.slug,
    name: spec.name,
    enabled: spec.enabled,
    domains: spec.domains,
  };
  if (spec.framework) entry.framework = spec.framework;

  // Nested tables — only emit keys that carry information so the
  // serialized TOML stays close to what a human would write.
  if (spec.source.type === 'git') {
    const src: Record<string, unknown> = { type: 'git' };
    if (spec.source.repo) src.repo = spec.source.repo;
    if (spec.source.branch) src.branch = spec.source.branch;
    if (spec.source.rootPath) src.root_path = spec.source.rootPath;
    entry.source = src;
  } else {
    entry.source = { type: 'tar', url: spec.source.url };
  }

  if (spec.build) {
    const build: Record<string, unknown> = {};
    if (spec.build.command) build.command = spec.build.command;
    if (spec.build.outDir) build.out_dir = spec.build.outDir;
    if (Object.keys(build).length > 0) entry.build = build;
  }

  if (Object.keys(spec.env).length > 0) entry.env = spec.env;

  return entry;
}

/**
 * Stable hash over everything that should trigger a redeploy when it
 * changes. Stored in `deployments.metadata.manifest_hash`; the sweep
 * compares it to decide whether to re-deploy on a manifest commit.
 *
 * `slug` and `name` are intentionally excluded — renaming an app
 * doesn't change what gets deployed.
 */
export function manifestHashForApp(spec: AppSpec): string {
  const canonical = JSON.stringify({
    source: spec.source,
    build: spec.build,
    env: spec.env,
    domains: [...spec.domains].sort(),
    framework: spec.framework,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Derive the stable, free `*.style.dev` URL an app gets when it declares no
 * domains of its own. Deterministic per (project, slug) so redeploys keep the
 * same address, and DNS-safe (underscores → dashes, label ≤ 63 chars). The
 * short hash keeps it unique across the shared Freestyle account so two
 * projects can both have an app called "site" without colliding.
 */
function defaultAppDomain(projectId: string, slug: string): string {
  const hash = createHash('sha256').update(`${projectId}:${slug}`).digest('hex').slice(0, 8);
  const label = slug.replace(/_/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'app';
  return `${label}-${hash}.style.dev`;
}

/**
 * The domains the provider should actually serve an app on: its declared
 * domains, or the auto-issued default when it declared none.
 */
export function resolveAppDomains(projectId: string, spec: AppSpec): string[] {
  return spec.domains.length > 0 ? spec.domains : [defaultAppDomain(projectId, spec.slug)];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ParseOk { ok: true; spec: AppSpec }
interface ParseErr { ok: false; error: AppParseError }

function parseAppEntry(entry: unknown, index: number): ParseOk | ParseErr {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return err('(invalid)', `[[apps]] entry #${index + 1} is not a table`);
  }
  const row = entry as Record<string, unknown>;

  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slug) return err(`(index-${index})`, `[[apps]] entry #${index + 1} is missing a slug`);
  if (!SLUG_RE.test(slug)) {
    return err(slug, `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`);
  }

  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : slug;
  const enabled = coerceBool(row.enabled, true);

  // Domains — optional. Omit them and the platform auto-issues a stable,
  // free `*.style.dev` URL at deploy time (see `defaultAppDomain`), so the
  // zero-config "vibecode an app and ship it" path needs no DNS setup. When
  // present, every entry must be a non-empty string.
  const domainsRaw = row.domains;
  const domains: string[] = [];
  if (domainsRaw !== undefined) {
    if (!Array.isArray(domainsRaw)) {
      return err(slug, 'domains must be an array of strings when set');
    }
    for (const d of domainsRaw) {
      if (typeof d !== 'string' || !d.trim()) {
        return err(slug, 'domains entries must be non-empty strings');
      }
      domains.push(d.trim());
    }
  }

  const framework = typeof row.framework === 'string' && row.framework.trim()
    ? row.framework.trim()
    : null;

  // [apps.source] — required nested table.
  const sourceParsed = parseAppSource(slug, row.source);
  if (!sourceParsed.ok) return sourceParsed;

  // [apps.build] — optional nested table.
  const buildParsed = parseAppBuild(slug, row.build);
  if (!buildParsed.ok) return buildParsed;

  // [apps.env] — optional flat table of string values.
  const envParsed = parseAppEnv(slug, row.env);
  if (!envParsed.ok) return envParsed;

  const path = `${MANIFEST_FILENAME}#apps.${slug}`;
  return {
    ok: true,
    spec: {
      slug,
      path,
      name,
      enabled,
      source: sourceParsed.value,
      build: buildParsed.value,
      env: envParsed.value,
      domains,
      framework,
    },
  };
}

function parseAppSource(
  slug: string,
  raw: unknown,
): { ok: true; value: AppSourceSpec } | ParseErr {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return err(slug, '[apps.source] is required and must be a table');
  }
  const row = raw as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
  if (type === 'git') {
    const repo = typeof row.repo === 'string' && row.repo.trim() ? row.repo.trim() : null;
    const branch = typeof row.branch === 'string' && row.branch.trim() ? row.branch.trim() : null;
    const rootPath = typeof row.root_path === 'string' && row.root_path.trim()
      ? row.root_path.trim()
      : typeof row.rootPath === 'string' && row.rootPath.trim()
        ? row.rootPath.trim()
        : null;
    // repo is allowed to be null — the deploy path will substitute the
    // project's own repoUrl when missing.
    return { ok: true, value: { type: 'git', repo, branch, rootPath } };
  }
  if (type === 'tar') {
    const url = typeof row.url === 'string' && row.url.trim() ? row.url.trim() : '';
    if (!url) return err(slug, '[apps.source] type="tar" requires a non-empty url');
    return { ok: true, value: { type: 'tar', url } };
  }
  return err(slug, `[apps.source].type must be "git" or "tar" (got "${type || 'unset'}")`);
}

function parseAppBuild(
  slug: string,
  raw: unknown,
): { ok: true; value: AppBuildSpec | null } | ParseErr {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return err(slug, '[apps.build] must be a table');
  }
  const row = raw as Record<string, unknown>;
  const command = typeof row.command === 'string' && row.command.trim() ? row.command.trim() : null;
  const outDir = typeof row.out_dir === 'string' && row.out_dir.trim()
    ? row.out_dir.trim()
    : typeof row.outDir === 'string' && row.outDir.trim()
      ? row.outDir.trim()
      : null;
  if (!command && !outDir) return { ok: true, value: null };
  return { ok: true, value: { command, outDir } };
}

function parseAppEnv(
  slug: string,
  raw: unknown,
): { ok: true; value: Record<string, string> } | ParseErr {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return err(slug, '[apps.env] must be a table of string values');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      return err(slug, `[apps.env].${k} must be a string (got ${typeof v})`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      return err(slug, `[apps.env] key "${k}" must look like an env var name`);
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return fallback;
}

function err(slug: string, message: string): ParseErr {
  return {
    ok: false,
    error: { slug, path: `${MANIFEST_FILENAME}#apps.${slug}`, error: message },
  };
}
