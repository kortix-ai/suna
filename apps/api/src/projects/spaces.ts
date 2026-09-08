/**
 * Spaces — the manifest half.
 *
 * A space is a named container INSIDE a project: it groups sessions, owns
 * the triggers that name it, may declare agents of its own, and is an IAM
 * object granted exactly like an agent. Every space lives in the ROOT
 * MANIFEST under `spaces:`, keyed by slug (user, 2026-09-08: "we don't need
 * different files for this, we can have everything in kortix.yaml"). The
 * database holds only the session join (`project_sessions.space`) and the
 * grants (`role_assignments`, `object_type = 'space'`).
 *
 * This module is the direct analogue of `./agents.ts` for that map: read it,
 * parse each block, and serialize one back. Authorization lives next door in
 * `lib/space-access.ts` — nothing here is a permission.
 *
 * What the one-file move deleted: listing the repo for `kortix-<slug>.yaml`
 * siblings, reading N files, the per-file read-error branch, and the
 * duplicate-slug error (a YAML map cannot repeat a key). A space is now
 * exactly as reachable as the manifest it lives in.
 *
 * A v1 (kortix.toml) project has no spaces: `spaces:` is not read at all,
 * the same back-compat rule every other v2-only block follows.
 */
import { posix as posixPath } from 'node:path';
import {
  SPACE_SESSIONS_MODES_V2,
  isAgentReferenceV2,
  parseManifestText,
  validateSpaceEntryV2,
  type ManifestIssue,
} from '@kortix/manifest-schema';
import { extractAgents, type AgentSpec, type LoadedAgents } from './agents';
import type { GitBackedProject } from './git';
import { readRepoFile } from './git';
import { MANIFEST_FILENAME, type ParsedManifest } from './triggers';

export type SpaceSessionsMode = (typeof SPACE_SESSIONS_MODES_V2)[number];

export interface SpaceSpec {
  /** URL-safe slug — the `spaces:` map key, unique per project, and the IAM
   *  object id. */
  slug: string;
  /** The manifest this space is declared in, repo-relative (`kortix.yaml`, or
   *  `<dir>/kortix.yaml` when the root manifest lives in a subdirectory).
   *  The SAME value for every space in a project now that they share one
   *  file — kept because it is what the UI and CLI cite when they tell
   *  someone where a space is configured. */
  path: string;
  /** Display label; defaults to the slug. */
  name: string;
  description: string | null;
  /** Default agent for sessions started here. A default, not a binding. */
  agent: string | null;
  /** `private` (default) keeps the ordinary per-session model; `shared` makes
   *  every session in the space readable by everyone granted it. */
  sessions: SpaceSessionsMode;
  /**
   * The agents usable here beyond the globals — the ones this space OWNS
   * (declares) and the ones it REFERENCES (`agents.<name>: { from: <slug> }`),
   * in declaration order. A host builds the roster as globals + these.
   */
  agents: string[];
  /** The agents this space declares. Each carries `space = slug`. */
  ownedAgents: AgentSpec[];
  /** `agents.<name>: { from }` entries — use imported from another space. */
  references: Array<{ name: string; from: string }>;
  /**
   * The raw `agents:` map exactly as written, or null when absent. Kept so a
   * rewrite of the other fields (`spaceSpecToManifestEntry`) never reformats
   * or drops a block it does not understand. Never serialized to the API.
   */
  agentsRaw: Record<string, unknown> | null;
}

export interface SpaceParseError {
  slug: string;
  path: string;
  error: string;
}

export interface LoadedSpaces {
  specs: SpaceSpec[];
  errors: SpaceParseError[];
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

function dirOf(filePath: string): string {
  const dir = posixPath.dirname(filePath.replace(/^\.?\//, ''));
  return dir === '.' ? '' : dir;
}

/** The directory the root manifest lives in — `''` for the repo root. Still
 *  used by the repo-config reader to scope its file listing. */
export function manifestDir(manifestPath: string | null | undefined): string {
  return dirOf(manifestPath || MANIFEST_FILENAME);
}

function issueText(issues: readonly ManifestIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

/**
 * Parse ONE `spaces.<slug>` block into a spec. Never throws — a schema
 * violation or a bad owned-agent block lands in the error branch with the
 * manifest path, so the UI can render it beside the good ones, exactly like
 * `extractTriggers`. Pure.
 */
export function parseSpaceEntry(
  slug: string,
  manifestPath: string,
  raw: unknown,
): { ok: true; spec: SpaceSpec } | { ok: false; error: SpaceParseError } {
  const fail = (error: string) => ({
    ok: false as const,
    error: { slug, path: manifestPath, error },
  });

  const issues: ManifestIssue[] = [];
  validateSpaceEntryV2(raw, slug, issues);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) return fail(issueText(errors));
  // `validateSpaceEntryV2` already rejected a non-table, so anything that
  // reaches here is one — an empty block (`marketing:` with no body) parses
  // as null and is the same as `{}`.
  const body: Record<string, unknown> = isTable(raw) ? raw : {};

  const agentsRaw = isTable(body.agents) ? body.agents : null;
  const owned: Record<string, unknown> = {};
  const references: Array<{ name: string; from: string }> = [];
  for (const [name, entry] of Object.entries(agentsRaw ?? {})) {
    if (isAgentReferenceV2(entry)) references.push({ name, from: entry.from });
    else owned[name] = entry;
  }
  // The same per-block reader the root's `agents:` map goes through, pointed
  // at the manifest so each spec's `path` reads
  // `kortix.yaml#agents.<name>` — the block's own address inside the file.
  const ownedLoaded = extractAgents({
    schemaVersion: 2,
    raw: { agents: owned },
    format: 'yaml',
    path: manifestPath,
  });
  if (ownedLoaded.errors.length > 0) {
    return fail(ownedLoaded.errors.map((e) => `${e.path}: ${e.error}`).join('; '));
  }
  const ownedByName = new Map(ownedLoaded.specs.map((spec) => [spec.name, spec]));
  const ownedAgents = Object.keys(owned)
    .map((name) => ownedByName.get(name))
    .filter((spec): spec is AgentSpec => Boolean(spec))
    .map((spec) => ({ ...spec, space: slug }));

  return {
    ok: true,
    spec: {
      slug,
      path: manifestPath,
      name: optionalString(body.name)?.trim() ?? slug,
      description: optionalString(body.description),
      agent: optionalString(body.agent)?.trim() ?? null,
      sessions: (body.sessions as SpaceSessionsMode | undefined) ?? 'private',
      agents: Object.keys(agentsRaw ?? {}),
      ownedAgents,
      references,
      agentsRaw,
    },
  };
}

/**
 * Parse a whole `spaces:` map. Specs and errors come back sorted by slug.
 * A missing or malformed map yields none — the manifest validator is what
 * reports that, not this loader. Pure.
 */
export function extractSpaces(manifestPath: string, rawSpaces: unknown): LoadedSpaces {
  const specs: SpaceSpec[] = [];
  const errors: SpaceParseError[] = [];
  if (isTable(rawSpaces)) {
    for (const [slug, raw] of Object.entries(rawSpaces)) {
      const result = parseSpaceEntry(slug, manifestPath, raw);
      if (result.ok) specs.push(result.spec);
      else errors.push(result.error);
    }
  }
  specs.sort((a, b) => a.slug.localeCompare(b.slug));
  errors.sort((a, b) => a.slug.localeCompare(b.slug));
  return { specs, errors };
}

/**
 * Read a project's spaces out of its root manifest. Never throws. Mirrors
 * `loadProjectAgents` — including the dynamic `./triggers` import that keeps
 * the module graph acyclic (git/config.ts imports this file).
 *
 * `opts.manifest` lets a caller that already read the root manifest (the
 * agents loader) skip the second read; `null` there means "no manifest".
 */
export async function loadProjectSpaces(
  project: GitBackedProject,
  opts?: { forceRefresh?: boolean; manifest?: ParsedManifest | null },
): Promise<LoadedSpaces> {
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
  // A v1 manifest has no spaces. A project with NO manifest yet has none
  // either — there is no file to hold them.
  if (!manifest || manifest.schemaVersion < 2) return { specs: [], errors: [] };
  return extractSpaces(manifest.path, manifest.raw.spaces);
}

/**
 * The spaces as they are at ONE ref — a session's `base_ref`, which may
 * differ from the default branch. Used by everything that compiles or boots
 * a session (envelope, agent config). Never throws; a manifest that cannot
 * be read or parsed is an `errors[]` entry.
 */
export async function loadProjectSpacesAtRef(
  project: GitBackedProject,
  opts: { manifestPath: string; ref: string },
): Promise<LoadedSpaces> {
  const path = opts.manifestPath.replace(/^\.?\//, '');
  let text: string;
  try {
    text = await readRepoFile(project, path, opts.ref);
  } catch (err) {
    return {
      specs: [],
      errors: [{ slug: '(manifest)', path, error: `Failed to read: ${(err as Error).message}` }],
    };
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseManifestText(text, path.endsWith('.toml') ? 'toml' : 'yaml');
  } catch (err) {
    return {
      specs: [],
      errors: [{ slug: '(manifest)', path, error: `not valid: ${(err as Error).message}` }],
    };
  }
  // Same v1 rule as `loadProjectSpaces`: no `spaces:` is read below v2.
  if (Number(raw.kortix_version ?? 1) < 2) return { specs: [], errors: [] };
  return extractSpaces(path, raw.spaces);
}

// ─── The usability rule (spec 2026-09-06 §2) ─────────────────────────────────
//
// An agent is usable in a session iff it is GLOBAL (declared in the root), or
// OWNED by the session's space, or REFERENCED by it. A project-level
// session (no space) may use global agents only. These helpers are the
// one place that rule is spelled out; the create gate, the trigger gate and
// the compiler all read them.

/** Global agent names — the ones declared in the root manifest. */
export function globalAgentNames(loaded: Pick<LoadedAgents, 'specs'>): string[] {
  return loaded.specs.filter((spec) => !spec.space).map((spec) => spec.name);
}

/** The agent names usable inside `space` (null = the whole project). */
export function usableAgentNames(
  loaded: Pick<LoadedAgents, 'specs'>,
  space: Pick<SpaceSpec, 'agents'> | null | undefined,
): string[] {
  const names = globalAgentNames(loaded);
  for (const name of space?.agents ?? []) if (!names.includes(name)) names.push(name);
  return names;
}

/** Is `agentName` usable inside `space` (null = the whole project)? */
export function agentUsableIn(
  loaded: Pick<LoadedAgents, 'specs'>,
  space: Pick<SpaceSpec, 'agents'> | null | undefined,
  agentName: string,
): boolean {
  return usableAgentNames(loaded, space).includes(agentName);
}

/** The raw `agents.<name>` blocks a space OWNS (references excluded). */
export function ownedAgentBlocks(spec: Pick<SpaceSpec, 'agentsRaw'>): Record<string, unknown> {
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
  spaces: readonly SpaceSpec[],
  slug: string | null | undefined,
): Record<string, unknown> {
  if (!slug) return {};
  const spec = spaces.find((s) => s.slug === slug);
  if (!spec) return {};
  const out = ownedAgentBlocks(spec);
  for (const ref of spec.references) {
    const owner = spaces.find((s) => s.slug === ref.from);
    const block = owner ? ownedAgentBlocks(owner)[ref.name] : undefined;
    if (block !== undefined) out[ref.name] = block;
  }
  return out;
}

/**
 * The file's raw object for a spec. Only non-default fields are emitted so an
 * untouched file stays byte-stable on round-trip; the `agents:` map is written
 * back exactly as it was read. A key this version dropped (`instructions`,
 * `context`) is not in the spec, so the first write after an edit sweeps it
 * out of the file.
 */
export function spaceSpecToManifestEntry(spec: SpaceSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (spec.name && spec.name !== spec.slug) entry.name = spec.name;
  if (spec.description) entry.description = spec.description;
  if (spec.agent) entry.agent = spec.agent;
  if (spec.sessions !== 'private') entry.sessions = spec.sessions;
  if (spec.agentsRaw && Object.keys(spec.agentsRaw).length > 0) entry.agents = spec.agentsRaw;
  return entry;
}

/**
 * Drop `space: <slug>` from every trigger naming it. Called on delete,
 * in the commit BEFORE the file is removed — a trigger pointing at a
 * space that no longer exists fails `validateTriggerSpaceRefsV2`
 * and would make the manifest set invalid in between.
 */
export function stripSpaceFromTriggers(
  manifest: ParsedManifest,
  slug: string,
): ParsedManifest {
  if (!Array.isArray(manifest.raw.triggers)) return manifest;
  const next = (manifest.raw.triggers as unknown[]).map((entry) => {
    if (!isTable(entry) || entry.space !== slug) return entry;
    const copy = { ...entry };
    delete copy.space;
    return copy;
  });
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}
