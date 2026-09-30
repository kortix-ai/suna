import {
  MANIFEST_FILENAME_YAML,
  type ManifestFormat,
  ManifestImportError,
  type ResolvedManifest,
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  serializeManifestObject,
  splitManifestByOrigin,
} from '@kortix/manifest-schema';
import { type GitBackedProject, readManifestFromRepo } from './git';
import type { ParsedManifest } from './trigger-types';

/** Where the manifest lives. Same path the rest of the platform looks for.
 *  A project may instead use `kortix.yaml` ({@link MANIFEST_FILENAME_YAML}) —
 *  reads prefer it if present; this stays the canonical name for breadcrumbs
 *  and the toml/legacy default. */
export const MANIFEST_FILENAME = 'kortix.toml';
export { MANIFEST_FILENAME_YAML };

/**
 * Schema version of the manifest. Bumped when we make a breaking change to
 * how the file is parsed. Manifests without `kortix_version` are treated as
 * v1 (backward compat). `KNOWN_SCHEMA_VERSION` deliberately stays `1` — it is
 * the version every v1 test fixture across this package stamps into its
 * `kortix_version` header and the version `parseAgentEntry`/`extractTriggers`'
 * v1 code paths were authored against; changing its VALUE would silently flip
 * every one of those v1-shaped fixtures onto the v2 reader below. See
 * `MAX_SCHEMA_VERSION` for the actual acceptance ceiling.
 */
export const KNOWN_SCHEMA_VERSION = 1;

/**
 * Highest schema version this reader (the one the session/trigger/grant
 * pipeline actually reads through — `readManifest`/`parseManifestString`)
 * accepts without throwing. `kortix_version: 2` (the `agents:` map + full
 * OpenCode `AgentConfig` parity + deny-by-default grants — see
 * `@kortix/manifest-schema`'s `ManifestV2`) is validated at write time by
 * `kortix validate` / the CR-merge gate; THIS reader must not also reject it,
 * or every v2 project's session grant resolution would fail closed/open
 * instead of reading the agent's declared grant (the runtime-wiring gap
 * fixed by `extractAgents` in `./agents.ts`, the v2-aware consumer). A version above
 * this ceiling is genuinely unknown to the platform and remains refused.
 */
export const MAX_SCHEMA_VERSION = 2;

/* ─── Manifest IO ───────────────────────────────────────────────────────── */

/**
 * Read + parse the project's manifest. Returns null if no manifest file is
 * present (so the caller can treat the repo as "not a Kortix project yet").
 * Throws on parse errors so the caller can surface them up — we don't
 * silently swallow a malformed manifest.
 *
 * DUAL-FORMAT: prefers `kortix.yaml` over `kortix.toml` when both exist, else
 * falls back to whichever is present (honoring a custom `manifest_path`). The
 * resolved file + format ride along on the ParsedManifest so the commit path
 * writes back to the exact same file in the same format.
 */
export async function readManifest(
  project: GitBackedProject,
  opts?: { forceRefresh?: boolean; rethrowReadErrors?: boolean },
): Promise<ParsedManifest | null> {
  let found: Awaited<ReturnType<typeof readManifestFromRepo>>;
  try {
    // manifest_path can still say kortix.toml (an older project, or a stale
    // default) even when the file actually on disk is kortix.yaml — so we
    // can't rely on it to point at the right format. We actively probe the
    // .yaml/.yml siblings first (manifestCandidatePaths), which also keeps
    // per-agent env/connector scoping ON for a yaml-only project (a missing
    // `agents:` read = grants resolve to null = unrestricted).
    const candidates = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
    found = await readManifestFromRepo(project, candidates, project.defaultBranch, {
      forceRefresh: opts?.forceRefresh,
      strictRef: opts?.rethrowReadErrors,
    });
  } catch (err) {
    // `readManifestFromRepo` returns null for a genuinely ABSENT file and only
    // THROWS when the read itself failed (mirror refresh, git-proxy hop,
    // ls-tree/show). Collapsing both to null is fine for callers that just want
    // "is there a manifest?", but it is unsafe for security decisions: a
    // transient git failure then looks identical to "blank project", which
    // `loadProjectAgents` answers with a synthesized `secrets: 'all'` manifest.
    // Callers that must fail CLOSED on an unreadable manifest opt into the
    // distinction here. See projects/lib/secret-grant.ts.
    // A broken import is a malformed manifest, not an absent one: it propagates
    // like a root syntax error does (thrown by `parseManifestString` below),
    // never laundered into the synthesized permissive manifest.
    if (err instanceof ManifestImportError) throw err;
    if (opts?.rethrowReadErrors) throw err;
    return null;
  }
  if (!found) return null;
  const manifest = parseManifestString(
    found.content,
    manifestFormatForPath(found.path),
    found.path,
    found.sha,
    found.candidatePaths,
    found.commit,
  );
  if (found.imports) manifest.imports = found.imports;
  return manifest;
}

/**
 * The agent name a synthesized (no-manifest-yet) v2 manifest declares as its
 * default — same name `@kortix/starter`'s `base` template seeds (see
 * packages/starter/templates/base/kortix.yaml's `default_agent: kortix` +
 * `agents.kortix`). Keeping the two in sync means a blank managed-git project
 * (provisioned WITHOUT `seed_starter:true`, so no kortix.yaml ever lands on
 * disk) self-heals into the exact shape a seeded one would already have.
 *
 * Exported (not file-local) because more than one reader needs the SAME
 * synthesized shape: `loadManifestForEdit` (lib/triggers.ts, the agent-config
 * write path) AND `loadProjectAgents` (./agents.ts, the session-create
 * declared-agent read path) both treat "no manifest committed yet" as if
 * this manifest already existed — otherwise the two paths disagree (PR
 * #4974 fixed only the write side; session-create still read `readManifest`'s
 * literal `null` and 400'd AGENT_NOT_DECLARED on a blank project's very
 * first session).
 */
export const SYNTHESIZED_DEFAULT_AGENT_NAME = 'kortix';

/**
 * Build the synthesized v2 manifest for a project with no kortix.yaml/
 * kortix.toml committed yet. Pure (no I/O) — callers decide when a `null`
 * `readManifest` result should be treated as this shape.
 *
 * MUST embed `kortix_version` INSIDE `raw` (not just carry it on the
 * `schemaVersion` wrapper) — `applyDefaultAgentV2`/`applyAgentBlockV2`
 * (lib/agent-config-v2.ts) call `validateManifest(manifest.raw, format)`
 * directly on this raw object (not through `serializeManifest`, which
 * re-injects `kortix_version` from `schemaVersion` on the way out). Without
 * the key present here, `validateRoot` reads the raw object as schema-version-
 * less and rejects it with "kortix_version is required" before ever reaching
 * the v2 body validators — the exact 400 a blank project's first
 * PUT /default-agent hit.
 */
export function synthesizeBlankManifest(project: {
  name?: string;
  manifestPath?: string | null;
}): ParsedManifest {
  const candidatePaths = manifestCandidatePaths(project.manifestPath ?? undefined).map(
    (candidate) => candidate.path,
  );
  return {
    schemaVersion: 2,
    raw: {
      kortix_version: 2,
      project: { name: project.name ?? '', description: '' },
      env: { required: [], optional: [] },
      default_agent: SYNTHESIZED_DEFAULT_AGENT_NAME,
      agents: {
        [SYNTHESIZED_DEFAULT_AGENT_NAME]: {
          connectors: 'all',
          secrets: 'all',
          kortix_permissions: 'all',
          skills: 'all',
          // Nobody declared this agent, so it keeps the project checkout a
          // declared agent must opt into (KRTX-165). Without it a blank
          // project's first session boots with no repo and fails to compile.
          repository_access: true,
        },
      },
    },
    format: 'yaml',
    path: candidatePaths[0] ?? MANIFEST_FILENAME_YAML,
    revision: null,
    candidatePaths,
  };
}

/**
 * Synchronous parse from a manifest string. Exported so the CRUD path can
 * round-trip (read existing string, parse, mutate, serialize) without touching
 * the network. `format`/`path` default to TOML/kortix.toml so an existing
 * caller passing only a string is unchanged.
 */
export function parseManifestString(
  raw: string,
  format: ManifestFormat = 'toml',
  path: string = format === 'yaml' ? MANIFEST_FILENAME_YAML : MANIFEST_FILENAME,
  revision?: string | null,
  candidatePaths?: string[],
  commit?: string | null,
): ParsedManifest {
  const parsed = parseManifestText(raw, format);
  const version =
    typeof parsed.kortix_version === 'number'
      ? parsed.kortix_version
      : typeof parsed.kortix_version === 'string'
        ? Number(parsed.kortix_version)
        : KNOWN_SCHEMA_VERSION;

  if (!Number.isFinite(version) || version < 1) {
    throw new Error('kortix_version must be a positive integer');
  }
  if (Math.floor(version) > MAX_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported ${path} schema version ${version}. This platform understands up to v${MAX_SCHEMA_VERSION}; upgrade the platform or pin the manifest.`,
    );
  }

  const manifest: ParsedManifest = {
    schemaVersion: Math.floor(version),
    raw: parsed,
    format,
    path,
  };
  if (revision !== undefined) manifest.revision = revision;
  if (candidatePaths !== undefined) manifest.candidatePaths = candidatePaths;
  if (commit !== undefined) manifest.commit = commit;
  return manifest;
}

/** Serialize a parsed manifest back to text (in its own format) for committing. */
export function serializeManifest(manifest: ParsedManifest): string {
  // Ensure kortix_version is the FIRST key so the manifest is self-describing at
  // a glance. Both smol-toml and the yaml package emit keys in insertion order.
  const out: Record<string, unknown> = { kortix_version: manifest.schemaVersion };
  for (const [key, value] of Object.entries(manifest.raw)) {
    if (key === 'kortix_version') continue;
    out[key] = value;
  }
  return serializeManifestObject(out, manifest.format);
}

/** What one manifest edit commits: the file(s) to write, plus the imported
 *  files that must be unchanged for the write to be safe. */
export interface ManifestWrites {
  files: Array<{ path: string; content: string }>;
  alsoExpect: Array<{ path: string; sha: string }>;
}

/**
 * The file writes for an edited manifest — THE serializer every commit path
 * uses. Without `imports:` it is the root file, exactly as before. With
 * imports, `manifest.raw` is the merged document, so it is split back by
 * origin: an edited entry is written to the file that declares it, a new entry
 * to the root, and only files whose content changed are written. Serializing
 * `manifest.raw` straight into the root instead would copy every imported
 * entry into it and make the next read fail on duplicate names.
 */
export function manifestWrites(manifest: ParsedManifest, fallbackPath?: string): ManifestWrites {
  const rootPath = manifest.path || fallbackPath || MANIFEST_FILENAME;
  if (!manifest.imports) {
    return { files: [{ path: rootPath, content: serializeManifest(manifest) }], alsoExpect: [] };
  }
  const [root, ...imported] = splitManifestByOrigin(manifest.imports, manifest.raw);
  const files: ManifestWrites['files'] = [];
  const changedImports = imported.filter((file) => file.changed);
  if (root && (root.changed || changedImports.length === 0)) {
    files.push({ path: rootPath, content: serializeManifest({ ...manifest, raw: root.raw }) });
  }
  for (const file of changedImports) {
    files.push({ path: file.path, content: serializeManifestObject(file.raw, 'yaml') });
  }
  const alsoExpect = imported.flatMap((file) =>
    typeof file.revision === 'string' ? [{ path: file.path, sha: file.revision }] : [],
  );
  return { files, alsoExpect };
}
