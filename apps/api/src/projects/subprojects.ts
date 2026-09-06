/**
 * Subprojects — the manifest half.
 *
 * A subproject is a named container INSIDE a project: it groups sessions, gives
 * the agent standing instructions plus context files, owns the triggers that
 * name it, may declare agents of its own, and is an IAM object granted exactly
 * like an agent. Each subproject is ONE FILE, `kortix-<slug>.yaml`, beside the
 * root manifest (spec `docs/specs/2026-09-06-subproject-files-and-scoped-agents.md`);
 * the slug is the filename. The database holds only the session join
 * (`project_sessions.subproject`) and the grants (`role_assignments`,
 * `object_type = 'subproject'`).
 *
 * This module is the direct analogue of `./agents.ts` for those files: find
 * them, parse them, load them for a project, and serialize one back.
 * Authorization lives next door in `lib/subproject-access.ts` — nothing here
 * is a permission.
 *
 * A v1 (kortix.toml) project has no subprojects: the files are not even
 * listed, the same back-compat rule every other v2-only block follows.
 */
import { posix as posixPath } from 'node:path';
import {
  SUBPROJECT_SESSIONS_MODES_V2,
  isAgentReferenceV2,
  parseManifestText,
  subprojectFilePath,
  subprojectSlugFromPath,
  validateSubprojectFileV2,
  type ManifestIssue,
} from '@kortix/manifest-schema';
import { extractAgents, type AgentSpec, type LoadedAgents } from './agents';
import type { GitBackedProject } from './git';
import { listRepoFiles, readRepoFile } from './git';
import type { ProjectFileEntry } from './git/types';
import { MANIFEST_FILENAME, type ParsedManifest } from './triggers';

export type SubprojectSessionsMode = (typeof SUBPROJECT_SESSIONS_MODES_V2)[number];

export interface SubprojectSpec {
  /** URL-safe slug — the filename, unique per project, and the IAM object id. */
  slug: string;
  /** The file it lives in, repo-relative: `kortix-<slug>.yaml` (or `<dir>/kortix-<slug>.yaml`
   *  when the root manifest lives in a subdirectory). */
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
  /**
   * The agents usable here beyond the globals — the ones this file OWNS
   * (declares) and the ones it REFERENCES (`agents.<name>: { from: <slug> }`),
   * in file order. A host builds the roster as globals + these.
   */
  agents: string[];
  /** The agents this file declares. Each carries `subproject = slug`. */
  ownedAgents: AgentSpec[];
  /** `agents.<name>: { from }` entries — use imported from another subproject. */
  references: Array<{ name: string; from: string }>;
  /**
   * The raw `agents:` map exactly as written, or null when absent. Kept so a
   * rewrite of the other fields (`subprojectSpecToFileEntry`) never reformats
   * or drops a block it does not understand. Never serialized to the API.
   */
  agentsRaw: Record<string, unknown> | null;
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

/** One subproject file as read from the repo, before parsing. */
export interface SubprojectFile {
  slug: string;
  path: string;
  content: string;
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

function dirOf(filePath: string): string {
  const dir = posixPath.dirname(filePath.replace(/^\.?\//, ''));
  return dir === '.' ? '' : dir;
}

/** The directory the root manifest lives in — `''` for the repo root. This is
 *  where subproject files are looked for; nowhere else. */
export function manifestDir(manifestPath: string | null | undefined): string {
  return dirOf(manifestPath || MANIFEST_FILENAME);
}

/** The repo-relative path a subproject with `slug` lives at, next to the root
 *  manifest at `manifestPath`. */
export function subprojectPathFor(manifestPath: string | null | undefined, slug: string): string {
  return subprojectFilePath(manifestDir(manifestPath), slug);
}

/**
 * Pick the subproject files out of a repo listing: every `kortix-<slug>.yaml`
 * in `dir` (exactly that directory, never below it), sorted by slug. Pure.
 */
export function subprojectFileEntries(
  files: readonly (ProjectFileEntry | string)[],
  dir: string,
): Array<{ slug: string; path: string }> {
  const out: Array<{ slug: string; path: string }> = [];
  for (const file of files) {
    const filePath = typeof file === 'string' ? file : file.path;
    if (dirOf(filePath) !== dir) continue;
    const slug = subprojectSlugFromPath(filePath);
    if (!slug) continue;
    out.push({ slug, path: filePath.replace(/^\.?\//, '') });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function issueText(issues: readonly ManifestIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

/**
 * Parse ONE subproject file into a spec. Never throws — invalid YAML, a
 * schema violation, or a bad owned-agent block all land in the error branch
 * with the file's path, so the UI can render it beside the good ones, exactly
 * like `extractTriggers`. Pure.
 */
export function parseSubprojectFile(
  slug: string,
  filePath: string,
  content: string,
): { ok: true; spec: SubprojectSpec } | { ok: false; error: SubprojectParseError } {
  const fail = (error: string) => ({ ok: false as const, error: { slug, path: filePath, error } });

  let raw: Record<string, unknown>;
  try {
    raw = parseManifestText(content, 'yaml');
  } catch (err) {
    return fail(`not valid YAML: ${(err as Error).message}`);
  }

  const issues: ManifestIssue[] = [];
  validateSubprojectFileV2(raw, slug, issues);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) return fail(issueText(errors));

  const agentsRaw = isTable(raw.agents) ? raw.agents : null;
  const owned: Record<string, unknown> = {};
  const references: Array<{ name: string; from: string }> = [];
  for (const [name, entry] of Object.entries(agentsRaw ?? {})) {
    if (isAgentReferenceV2(entry)) references.push({ name, from: entry.from });
    else owned[name] = entry;
  }
  // The same per-block reader the root's `agents:` map goes through, pointed
  // at this file so each spec's `path` reads `kortix-<slug>.yaml#agents.<name>`.
  const ownedLoaded = extractAgents({
    schemaVersion: 2,
    raw: { agents: owned },
    format: 'yaml',
    path: filePath,
  });
  if (ownedLoaded.errors.length > 0) {
    return fail(ownedLoaded.errors.map((e) => `${e.path}: ${e.error}`).join('; '));
  }
  const ownedByName = new Map(ownedLoaded.specs.map((spec) => [spec.name, spec]));
  const ownedAgents = Object.keys(owned)
    .map((name) => ownedByName.get(name))
    .filter((spec): spec is AgentSpec => Boolean(spec))
    .map((spec) => ({ ...spec, subproject: slug }));

  return {
    ok: true,
    spec: {
      slug,
      path: filePath,
      name: optionalString(raw.name)?.trim() ?? slug,
      description: optionalString(raw.description),
      instructions: optionalString(raw.instructions),
      context: Array.isArray(raw.context) ? raw.context.map((item) => String(item).trim()) : [],
      agent: optionalString(raw.agent)?.trim() ?? null,
      sessions: (raw.sessions as SubprojectSessionsMode | undefined) ?? 'private',
      agents: Object.keys(agentsRaw ?? {}),
      ownedAgents,
      references,
      agentsRaw,
    },
  };
}

/** Parse many files. Specs and errors come back sorted by slug. Pure. */
export function extractSubprojectsFromFiles(files: readonly SubprojectFile[]): LoadedSubprojects {
  const specs: SubprojectSpec[] = [];
  const errors: SubprojectParseError[] = [];
  for (const file of files) {
    const result = parseSubprojectFile(file.slug, file.path, file.content);
    if (result.ok) specs.push(result.spec);
    else errors.push(result.error);
  }
  specs.sort((a, b) => a.slug.localeCompare(b.slug));
  errors.sort((a, b) => a.slug.localeCompare(b.slug));
  return { specs, errors };
}

/**
 * Read a project's subproject files and parse them. Never throws. Mirrors
 * `loadProjectAgents` — including the dynamic `./triggers` import that keeps
 * the module graph acyclic (git/config.ts imports this file).
 *
 * `opts.manifest` lets a caller that already read the root manifest (the
 * agents loader) skip the second read; `null` there means "no manifest".
 */
export async function loadProjectSubprojects(
  project: GitBackedProject,
  opts?: { forceRefresh?: boolean; manifest?: ParsedManifest | null },
): Promise<LoadedSubprojects> {
  let manifest: ParsedManifest | null;
  if (opts && 'manifest' in opts) {
    manifest = opts.manifest ?? null;
  } else {
    const { readManifest } = await import('./triggers');
    try {
      manifest = await readManifest(project, { forceRefresh: opts?.forceRefresh });
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
  }
  // A v1 manifest has no subprojects. A project with NO manifest yet is the
  // synthesized-v2 case every other reader assumes (`loadProjectAgents`), so
  // its files are looked for beside the configured manifest path.
  if (manifest && manifest.schemaVersion < 2) return { specs: [], errors: [] };

  const dir = manifestDir(manifest?.path ?? project.manifestPath);
  let entries: Array<{ slug: string; path: string }>;
  try {
    entries = subprojectFileEntries(
      await listRepoFiles(project, project.defaultBranch, dir || null),
      dir,
    );
  } catch (err) {
    return {
      specs: [],
      errors: [
        {
          slug: '(manifest)',
          path: dir ? `${dir}/` : '.',
          error: `Failed to list subproject files: ${(err as Error).message}`,
        },
      ],
    };
  }

  const files: SubprojectFile[] = [];
  const readErrors: SubprojectParseError[] = [];
  for (const entry of entries) {
    try {
      files.push({
        ...entry,
        content: await readRepoFile(project, entry.path, project.defaultBranch),
      });
    } catch (err) {
      readErrors.push({
        slug: entry.slug,
        path: entry.path,
        error: `Failed to read: ${(err as Error).message}`,
      });
    }
  }
  const loaded = extractSubprojectsFromFiles(files);
  return {
    specs: loaded.specs,
    errors: [...loaded.errors, ...readErrors].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

/**
 * The subproject files as they are at ONE ref — a session's `base_ref`, which
 * may differ from the default branch. Used by everything that compiles or
 * boots a session (envelope, agent config). Never throws; a file that cannot
 * be read is an `errors[]` entry.
 */
export async function loadProjectSubprojectsAtRef(
  project: GitBackedProject,
  opts: { manifestPath: string; ref: string },
): Promise<LoadedSubprojects> {
  const dir = manifestDir(opts.manifestPath);
  const entries = subprojectFileEntries(await listRepoFiles(project, opts.ref, dir || null), dir);
  const files: SubprojectFile[] = [];
  const errors: SubprojectParseError[] = [];
  for (const entry of entries) {
    try {
      files.push({ ...entry, content: await readRepoFile(project, entry.path, opts.ref) });
    } catch (err) {
      errors.push({ slug: entry.slug, path: entry.path, error: `Failed to read: ${(err as Error).message}` });
    }
  }
  const loaded = extractSubprojectsFromFiles(files);
  return { specs: loaded.specs, errors: [...loaded.errors, ...errors] };
}

// ─── The usability rule (spec 2026-09-06 §2) ─────────────────────────────────
//
// An agent is usable in a session iff it is GLOBAL (declared in the root), or
// OWNED by the session's subproject, or REFERENCED by it. A project-level
// session (no subproject) may use global agents only. These helpers are the
// one place that rule is spelled out; the create gate, the trigger gate and
// the compiler all read them.

/** Global agent names — the ones declared in the root manifest. */
export function globalAgentNames(loaded: Pick<LoadedAgents, 'specs'>): string[] {
  return loaded.specs.filter((spec) => !spec.subproject).map((spec) => spec.name);
}

/** The agent names usable inside `subproject` (null = the whole project). */
export function usableAgentNames(
  loaded: Pick<LoadedAgents, 'specs'>,
  subproject: Pick<SubprojectSpec, 'agents'> | null | undefined,
): string[] {
  const names = globalAgentNames(loaded);
  for (const name of subproject?.agents ?? []) if (!names.includes(name)) names.push(name);
  return names;
}

/** Is `agentName` usable inside `subproject` (null = the whole project)? */
export function agentUsableIn(
  loaded: Pick<LoadedAgents, 'specs'>,
  subproject: Pick<SubprojectSpec, 'agents'> | null | undefined,
  agentName: string,
): boolean {
  return usableAgentNames(loaded, subproject).includes(agentName);
}

/** The raw `agents.<name>` blocks a subproject OWNS (references excluded). */
export function ownedAgentBlocks(spec: Pick<SubprojectSpec, 'agentsRaw'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(spec.agentsRaw ?? {})) {
    if (!isAgentReferenceV2(entry)) out[name] = entry;
  }
  return out;
}

/**
 * The raw agent blocks usable inside `slug`, beyond the root's: the ones it
 * owns plus, for each reference, the block from the owning file. Feeds the
 * compiler, which needs blocks, not names. `{}` for the whole project.
 */
export function agentBlocksUsableIn(
  subprojects: readonly SubprojectSpec[],
  slug: string | null | undefined,
): Record<string, unknown> {
  if (!slug) return {};
  const spec = subprojects.find((s) => s.slug === slug);
  if (!spec) return {};
  const out = ownedAgentBlocks(spec);
  for (const ref of spec.references) {
    const owner = subprojects.find((s) => s.slug === ref.from);
    const block = owner ? ownedAgentBlocks(owner)[ref.name] : undefined;
    if (block !== undefined) out[ref.name] = block;
  }
  return out;
}

/**
 * The file's raw object for a spec. Only non-default fields are emitted so an
 * untouched file stays byte-stable on round-trip; the `agents:` map is written
 * back exactly as it was read.
 */
export function subprojectSpecToFileEntry(spec: SubprojectSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (spec.name && spec.name !== spec.slug) entry.name = spec.name;
  if (spec.description) entry.description = spec.description;
  if (spec.instructions) entry.instructions = spec.instructions;
  if (spec.context.length > 0) entry.context = [...spec.context];
  if (spec.agent) entry.agent = spec.agent;
  if (spec.sessions !== 'private') entry.sessions = spec.sessions;
  if (spec.agentsRaw && Object.keys(spec.agentsRaw).length > 0) entry.agents = spec.agentsRaw;
  return entry;
}

/**
 * Drop `subproject: <slug>` from every trigger naming it. Called on delete,
 * in the commit BEFORE the file is removed — a trigger pointing at a
 * subproject that no longer exists fails `validateTriggerSubprojectRefsV2`
 * and would make the manifest set invalid in between.
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
