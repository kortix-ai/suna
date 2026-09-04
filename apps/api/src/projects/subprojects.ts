/**
 * Subprojects — the manifest half.
 *
 * A subproject is a named container INSIDE a project: it groups sessions, gives
 * the agent standing instructions plus context files, owns the triggers that
 * name it, and is an IAM object granted exactly like an agent. The manifest
 * (`kortix.yaml` → `subprojects.<slug>`) is the source of truth; the database
 * holds only the session join (`project_sessions.subproject`) and the grants
 * (`role_assignments`, `object_type = 'subproject'`).
 *
 * This module is the direct analogue of `./agents.ts` for that block: parse it,
 * load it for a project, and write it back. Authorization lives next door in
 * `lib/subproject-access.ts` — nothing here is a permission.
 *
 * v1 (kortix.toml) manifests have no `subprojects:` section; they parse to an
 * empty set rather than an error, the same back-compat rule every other v2-only
 * block follows.
 */

import { SLUG_RE, SUBPROJECT_SESSIONS_MODES_V2 } from '@kortix/manifest-schema';
import type { GitBackedProject } from './git';
import { MANIFEST_FILENAME, type ParsedManifest } from './triggers';

export type SubprojectSessionsMode = (typeof SUBPROJECT_SESSIONS_MODES_V2)[number];

export interface SubprojectSpec {
  /** URL-safe slug — unique per project, and the IAM object id. */
  slug: string;
  /** `<manifest-file>#subprojects.<slug>` — a breadcrumb for the UI. */
  path: string;
  /** Display label; defaults to the slug. */
  name: string;
  description: string | null;
  /** Standing instructions, inline markdown. Delivered to the sandbox by env. */
  instructions: string | null;
  /** Repo-relative files/directories the agent is told to read first. */
  context: string[];
  /** Default agent for sessions started here. A default, not a binding. */
  agent: string | null;
  /** `private` (default) keeps the ordinary per-session model; `shared` makes
   *  every session in the subproject readable by everyone granted it. */
  sessions: SubprojectSessionsMode;
}

export interface SubprojectParseError {
  slug: string;
  path: string;
  error: string;
}

export interface LoadedSubprojects {
  specs: SubprojectSpec[];
  errors: SubprojectParseError[];
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

/** A repo-relative path: non-empty, not absolute, no `..` segment. Mirrors
 *  `isRepoRelativePath` in @kortix/manifest-schema so the API refuses exactly
 *  what the manifest validator refuses. */
export function isRepoRelativeContextPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const p = value.trim();
  if (!p || p.startsWith('/') || p.startsWith('\\')) return false;
  return !p.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * Parse the `subprojects:` map out of a loaded manifest. Never throws — a bad
 * block lands in `errors` with its slug so the UI can render it alongside the
 * good ones, exactly like `extractTriggers`.
 */
export function extractSubprojects(manifest: ParsedManifest): LoadedSubprojects {
  const filename = manifest.path || MANIFEST_FILENAME;
  const raw = manifest.raw.subprojects;
  if (raw === undefined || raw === null) return { specs: [], errors: [] };
  // v1 manifests have no subprojects block at all; a `subprojects` key there is
  // ignored rather than reported, matching the schema's v1 rule.
  if (manifest.schemaVersion < 2) return { specs: [], errors: [] };
  if (!isTable(raw)) {
    return {
      specs: [],
      errors: [
        {
          slug: '(top-level)',
          path: filename,
          error: '`subprojects` must be a map of subproject slug → block.',
        },
      ],
    };
  }

  const specs: SubprojectSpec[] = [];
  const errors: SubprojectParseError[] = [];
  for (const [slug, entry] of Object.entries(raw)) {
    const path = `${filename}#subprojects.${slug}`;
    const fail = (error: string) => errors.push({ slug, path, error });
    if (!SLUG_RE.test(slug)) {
      fail(`Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`);
      continue;
    }
    if (!isTable(entry)) {
      fail('a subproject must be a table (use `{}` for an empty one)');
      continue;
    }
    const sessionsRaw = entry.sessions;
    if (
      sessionsRaw !== undefined &&
      !(SUBPROJECT_SESSIONS_MODES_V2 as readonly unknown[]).includes(sessionsRaw)
    ) {
      fail(
        `sessions must be one of ${SUBPROJECT_SESSIONS_MODES_V2.map((m) => `"${m}"`).join(', ')}`,
      );
      continue;
    }
    let context: string[] = [];
    if (entry.context !== undefined && entry.context !== null) {
      if (!Array.isArray(entry.context)) {
        fail('context must be a list of repo-relative paths');
        continue;
      }
      const bad = entry.context.find((item) => !isRepoRelativeContextPath(item));
      if (bad !== undefined) {
        fail(
          'each context entry must be a non-empty repo-relative path (no leading "/" and no "..")',
        );
        continue;
      }
      context = entry.context.map((item) => (item as string).trim());
    }
    specs.push({
      slug,
      path,
      name: optionalString(entry.name)?.trim() ?? slug,
      description: optionalString(entry.description),
      instructions: optionalString(entry.instructions),
      context,
      agent: optionalString(entry.agent)?.trim() ?? null,
      sessions: (sessionsRaw as SubprojectSessionsMode | undefined) ?? 'private',
    });
  }
  specs.sort((a, b) => a.slug.localeCompare(b.slug));
  errors.sort((a, b) => a.slug.localeCompare(b.slug));
  return { specs, errors };
}

/**
 * Read a project's manifest and extract its subprojects. Mirrors
 * `loadProjectAgents` — including the dynamic `./triggers` import that keeps
 * the module graph acyclic (git/config.ts imports this file).
 */
export async function loadProjectSubprojects(
  project: GitBackedProject,
  opts?: { forceRefresh?: boolean },
): Promise<LoadedSubprojects> {
  const { readManifest } = await import('./triggers');
  let manifest: ParsedManifest | null;
  try {
    manifest = await readManifest(project, opts);
  } catch (err) {
    return {
      specs: [],
      errors: [
        {
          slug: '(manifest)',
          path: project.manifestPath || MANIFEST_FILENAME,
          error: (err as Error).message || 'Failed to read manifest',
        },
      ],
    };
  }
  if (!manifest) return { specs: [], errors: [] };
  return extractSubprojects(manifest);
}

/** The raw manifest entry for a spec. Only non-default fields are emitted so an
 *  untouched manifest stays byte-stable on round-trip. */
export function subprojectSpecToEntry(spec: SubprojectSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (spec.name && spec.name !== spec.slug) entry.name = spec.name;
  if (spec.description) entry.description = spec.description;
  if (spec.instructions) entry.instructions = spec.instructions;
  if (spec.context.length > 0) entry.context = [...spec.context];
  if (spec.agent) entry.agent = spec.agent;
  if (spec.sessions !== 'private') entry.sessions = spec.sessions;
  return entry;
}

/** Insert or replace a subproject by slug. */
export function upsertSubprojectInManifest(
  manifest: ParsedManifest,
  spec: SubprojectSpec,
): ParsedManifest {
  const current = isTable(manifest.raw.subprojects) ? manifest.raw.subprojects : {};
  return {
    ...manifest,
    raw: {
      ...manifest.raw,
      subprojects: { ...current, [spec.slug]: subprojectSpecToEntry(spec) },
    },
  };
}

/** Remove a subproject by slug. The `subprojects` key itself is dropped when
 *  the last one goes, so deleting the only subproject restores the manifest to
 *  the shape it had before any existed. */
export function removeSubprojectFromManifest(
  manifest: ParsedManifest,
  slug: string,
): ParsedManifest {
  const current = isTable(manifest.raw.subprojects) ? manifest.raw.subprojects : {};
  const next: Record<string, unknown> = { ...current };
  delete next[slug];
  const raw = { ...manifest.raw };
  if (Object.keys(next).length === 0) delete raw.subprojects;
  else raw.subprojects = next;
  return { ...manifest, raw };
}

/**
 * Drop `subproject: <slug>` from every trigger naming it. Called on delete, in
 * the SAME commit that removes the block — a trigger pointing at a subproject
 * that no longer exists fails `validateTriggerSubprojectRefsV2` and would make
 * the whole manifest invalid.
 */
export function stripSubprojectFromTriggers(
  manifest: ParsedManifest,
  slug: string,
): ParsedManifest {
  if (!Array.isArray(manifest.raw.triggers)) return manifest;
  const next = (manifest.raw.triggers as unknown[]).map((entry) => {
    if (!isTable(entry) || entry.subproject !== slug) return entry;
    const copy = { ...entry };
    delete copy.subproject;
    return copy;
  });
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}
