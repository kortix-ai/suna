import {
  MANIFEST_FILENAME_YAML,
  type ManifestFormat,
  ManifestImportError,
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  serializeManifestObject,
  splitManifestByOrigin,
} from '@kortix/manifest-schema';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
import { type GitBackedProject, type MirrorRefresh, readManifestFromRepo } from './git';
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
 * v3 retains the agents map and adds YAML-only behavior.
 */
export const MAX_SCHEMA_VERSION = 3;

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
  opts?: { forceRefresh?: MirrorRefresh; rethrowReadErrors?: boolean },
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
 * The agent name a synthesized (no-manifest-yet) v3 manifest declares as its
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
 * Build the synthesized v3 manifest for a project with no kortix.yaml/
 * kortix.toml committed yet: the starter's `kortix` agent, granted everything,
 * with the project checkout. Pure (no I/O) — callers decide when a `null`
 * `readManifest` result should be treated as this shape.
 *
 * MUST embed `kortix_version` INSIDE `raw` (not just carry it on the
 * `schemaVersion` wrapper) — `applyDefaultAgentV2`/`applyAgentBlockV2`
 * (lib/agent-config-v2.ts) call `validateManifest(manifest.raw, format)`
 * directly on this raw object (not through `serializeManifest`, which
 * re-injects `kortix_version` from `schemaVersion` on the way out). Without
 * the key present here, `validateRoot` reads the raw object as schema-version-
 * less and rejects it with "kortix_version is required" before ever reaching
 * the body validators — the exact 400 a blank project's first
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
    schemaVersion: 3,
    raw: {
      kortix_version: 3,
      project: { name: project.name ?? '', description: '' },
      default_agent: SYNTHESIZED_DEFAULT_AGENT_NAME,
      env: { required: [], optional: [] },
      agents: {
        [SYNTHESIZED_DEFAULT_AGENT_NAME]: {
          mode: 'primary',
          skills: 'all',
          subagents: 'all',
          commands: 'all',
          extensions: 'all',
          connectors: 'all',
          secrets: 'all',
          kortix_permissions: 'all',
          // Nobody declared this agent, so it keeps the project checkout
          // (KRTX-165). Without it a blank project's first session boots with
          // no repo and fails to compile.
          workspace: { project_repository: true },
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
  // Only YAML rides with its source: the yaml package's Document is lossless
  // (comments + blank lines), so an edit can be spliced back into the text.
  // A TOML parse is data-only — there is nothing to preserve.
  if (format === 'yaml') manifest.source = raw;
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
  // Comment-preserving path for YAML trigger edits (KRTX-2742): a plain
  // re-serialize rebuilds the file from the parsed object and strips every
  // comment. When we still have the source text, splice the trigger diff
  // into it instead — including a first trigger on a manifest that has no
  // `triggers` key yet (the splicer appends the list as a new block). Gate
  // on the desired data, never on the source text: a substring scan would
  // make comment preservation depend on whether a comment happens to say
  // "triggers". Anything the splice cannot prove equivalent falls back to
  // the full re-serialize below, so this can only change COMMENT
  // preservation, never data.
  if (
    manifest.format === 'yaml' &&
    typeof manifest.source === 'string' &&
    Array.isArray(out.triggers)
  ) {
    const spliced = spliceTriggerEntriesIntoYaml(out, manifest.source);
    if (spliced !== null) return spliced;
  }
  return serializeManifestObject(out, manifest.format);
}

/* ─── Comment-preserving YAML trigger writes (KRTX-2742) ────────────────── */

/** Structural view of a `yaml` Document node — the same narrowing idiom as
 *  the CLI's manifest-edit.ts. `range` is [start, end] offsets into the
 *  source text; an item's span starts at its first key (the `- ` marker
 *  precedes it on the same line) and includes its trailing newline. */
interface YamlNodeView {
  range?: [number, number, number] | null;
}
interface YamlSeqItemView extends YamlNodeView {
  get?(key: string): unknown;
  toJSON?(): unknown;
}
interface YamlSeqView extends YamlNodeView {
  items?: YamlSeqItemView[];
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** JSON round-trip so parsed-node values and desired objects compare equal
 *  regardless of node wrappers (undefined-valued keys, Dates). */
const canonicalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1;

/** Start of the contiguous comment block immediately above `from` — those
 *  comments annotate the entry at `from` and go where it goes (the CLI's
 *  removeArrayBlockYaml rule). A blank line breaks the walk. */
function commentBlockStart(text: string, from: number): number {
  let start = from;
  for (;;) {
    if (start <= 0 || text[start - 1] !== '\n') break;
    const prevStart = lineStart(text, start - 1);
    if (!text.slice(prevStart, start - 1).trimStart().startsWith('#')) break;
    start = prevStart;
  }
  return start;
}

/** Line holding the top-level `triggers:` key that owns the list starting at
 *  `from` (comments may sit between the key and its first item). */
function triggersKeyLineStart(text: string, from: number): number | null {
  let probe = lineStart(text, from);
  for (;;) {
    if (probe === 0) return null;
    const start = lineStart(text, probe - 1); // the line above
    const line = text.slice(start, probe);
    if (/^\s*triggers:\s*(#.*)?$/.test(line)) return start;
    if (!line.trimStart().startsWith('#') && line.trim() !== '') return null;
    probe = start;
  }
}

/** Render one trigger as a block-sequence item at `indent` — same shape the
 *  CLI's renderYamlSequenceItem emits. Continuation lines carry two extra
 *  spaces for the `- ` marker. Ends with a newline. */
function renderTriggerEntry(entry: Record<string, unknown>, indent: string): string {
  const lines = stringifyYaml(entry).trimEnd().split('\n');
  return lines.map((line, i) => `${indent}${i === 0 ? '- ' : '  '}${line}\n`).join('');
}

/** The desired list cannot be spliced anywhere (the file has no `triggers`
 *  sequence): append the list as a new top-level block, the CLI's
 *  appendArrayBlockYaml idiom. Re-serializing the document would re-indent
 *  its comments (KRTX-2742), so the block is appended as text. */
function appendTriggersBlock(
  source: string,
  entries: Array<Record<string, unknown>>,
): string {
  const header = 'triggers:\n';
  const block = entries.map((e) => renderTriggerEntry(e, '  ')).join('');
  const separator =
    source.length === 0 || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}${header}${block}`;
}

/**
 * Splice the desired trigger list into the manifest's original YAML text so
 * that everything OUTSIDE the changed entries — comments above all, sibling
 * entries, folded scalars, blank lines — stays byte-identical, instead of
 * reserializing the whole document (which strips every comment; KRTX-2742).
 *
 * Returns the edited text, or null when the edit is not a pure trigger-list
 * change this splicer understands (a non-trigger key changed, an exotic node
 * shape, anything unrenderable) — callers then fall back to the full
 * re-serialize. The result is verified before returning: it must parse and
 * carry exactly the data the plain re-serialize would. Callers may treat
 * null and a returned string identically: data-equal, comments or not.
 */
function spliceTriggerEntriesIntoYaml(
  desired: Record<string, unknown>,
  source: string,
): string | null {
  try {
    const wantedRaw = desired.triggers;
    if (!Array.isArray(wantedRaw)) return null;
    const wanted = new Map<string, Record<string, unknown>>();
    for (const entry of wantedRaw) {
      if (!isPlainObject(entry)) return null;
      const slug = entry.slug;
      if (typeof slug !== 'string' || slug === '' || wanted.has(slug)) return null;
      wanted.set(slug, entry);
    }

    const doc = parseDocument(source);
    const seq = doc.get('triggers', true) as YamlSeqView | undefined;
    if (!seq || !Array.isArray(seq.items) || !seq.range) {
      // No `triggers:` sequence to splice into: a trigger-less manifest
      // gains its list as a new block at the end of the file.
      if (wanted.size === 0) return null;
      return dataVerified(desired, appendTriggersBlock(source, [...wanted.values()]));
    }
    const items = seq.items;

    // An empty flow list (`triggers: []`) grows its first entries by
    // replacing the `[]` with a block sequence — appending after range[2]
    // would land outside the closed flow node.
    if (items.length === 0 && wanted.size > 0) {
      const rendered = [...wanted.values()].map((e) => renderTriggerEntry(e, '  ')).join('');
      const rest = source.slice(seq.range[1]);
      const text = `${source.slice(0, seq.range[0]).trimEnd()}\n${rendered}${
        rest.startsWith('\n') ? rest.slice(1) : rest
      }`;
      return dataVerified(desired, text);
    }

    const itemIndent = (() => {
      const first = items.find((item) => item.range);
      if (!first?.range) return '  ';
      return source.slice(lineStart(source, first.range[0]), first.range[0]).replace(/-\s*$/, '');
    })();

    // Per-entry text edits, collected on original offsets and applied back
    // to front so earlier offsets stay valid.
    const edits: TextEdit[] = [];
    let kept = 0;
    let removed = 0;
    for (const item of items) {
      const range = item?.range;
      if (!range) return null; // unrenderable node — safe fallback
      const slug = typeof item?.get === 'function' ? item.get('slug') : undefined;
      const wantedEntry = typeof slug === 'string' ? wanted.get(slug) : undefined;
      if (typeof slug === 'string') wanted.delete(slug);
      if (wantedEntry) {
        kept++;
        if (!isDeepStrictEqual(canonicalize(item.toJSON?.()), canonicalize(wantedEntry))) {
          // Replace the entry in place, from its `- ` marker through its
          // block. A comment above the marker sits outside this span and
          // survives untouched.
          edits.push({
            start: lineStart(source, range[0]),
            end: range[2],
            text: renderTriggerEntry(wantedEntry, itemIndent),
          });
        }
      } else {
        removed++;
        // The entry is going away — its own leading comment goes with it.
        edits.push({ start: commentBlockStart(source, lineStart(source, range[0])), end: range[2], text: '' });
      }
    }

    if (wanted.size > 0) {
      // New entries append after the last existing item, same list indent.
      // seq.range[2] is the end of the last item — larger than every edit
      // span above, so applying it first (back to front) is safe.
      edits.push({
        start: seq.range[2],
        end: seq.range[2],
        text: [...wanted.values()].map((e) => renderTriggerEntry(e, itemIndent)).join(''),
      });
    } else if (kept === 0 && removed > 0) {
      // Every entry removed and none re-added: collapse the empty list to
      // `triggers: []`, replacing the whole block from its key line down.
      const keyStart = triggersKeyLineStart(source, seq.range[0]);
      if (keyStart === null) return null;
      edits.length = 0;
      edits.push({ start: keyStart, end: seq.range[2], text: 'triggers: []\n' });
    }

    let text = source;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    return dataVerified(desired, text);
  } catch {
    return null;
  }
}

/** Prove the spliced text parses to exactly the data a full re-serialize
 *  would; null it (→ caller falls back) when it does not — the splice may
 *  only change comment preservation, never data. */
function dataVerified(desired: Record<string, unknown>, text: string): string | null {
  try {
    let candidate = text;
    const parsed = parseYaml(candidate);
    // The reader defaults a kortix_version the source file omits and
    // serializeManifest re-emits it first (today's behavior); the spliced
    // text gains the same line at the top so the data check compares equal.
    if (
      isPlainObject(parsed) &&
      parsed.kortix_version === undefined &&
      desired.kortix_version !== undefined
    ) {
      candidate = `kortix_version: ${desired.kortix_version}\n${candidate}`;
    }
    const written = canonicalize(parseYaml(candidate));
    const expected = canonicalize(parseYaml(stringifyYaml(desired)));
    return isDeepStrictEqual(written, expected) ? candidate : null;
  } catch {
    return null;
  }
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
