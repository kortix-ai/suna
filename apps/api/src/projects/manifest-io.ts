import {
  MANIFEST_FILENAME,
  fixManifestText,
  type ManifestIssue,
  ManifestImportError,
  isTable,
  manifestCandidatePaths,
  parseManifestText,
  renderManifest,
  rewriteManifestText,
  serializeManifestObject,
  splitManifestByOrigin,
  usableManifest,
  validateManifest,
} from '@kortix/manifest-schema';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
import { type GitBackedProject, type MirrorRefresh, readManifestFromRepo, resolveRemoteBranchTip } from './git';
import type { ParsedManifest } from './trigger-types';

/** Where the manifest lives (`kortix.yaml`, or `kortix.yml`). */
export { MANIFEST_FILENAME };

/* ─── Manifest IO ───────────────────────────────────────────────────────── */

type ManifestRead = Awaited<ReturnType<typeof readManifestFromRepo>>;

// replica-local: the connector sweep's last manifest read per project, keyed
// by the default-branch tip it was read at. A new leader starts empty.
const readsAtTip = new Map<string, { tip: string; candidates: string; found: ManifestRead }>();

/**
 * The connector sweep re-reads every project's manifest. Reading through the
 * mirror forced a fetch per project, and a full clone once the mirror cache
 * had evicted it: ~690 GB/day from GitHub on prod (2026-10-26). One
 * `ls-remote` of the default branch proves an earlier read is still current.
 */
async function readManifestAtRemoteTip(project: GitBackedProject, candidates: string[]): Promise<ManifestRead> {
  const tip = await resolveRemoteBranchTip(project, project.defaultBranch).catch(() => null);
  const key = candidates.join('\u0000');
  const hit = readsAtTip.get(project.projectId);
  if (tip && hit?.tip === tip && hit.candidates === key) return hit.found;
  const found = await readManifestFromRepo(project, candidates, project.defaultBranch, { forceRefresh: true });
  // A push between the ls-remote and the read: keep nothing, the next sweep reads again.
  if (tip && (found === null || found.commit === tip)) readsAtTip.set(project.projectId, { tip, candidates: key, found });
  else readsAtTip.delete(project.projectId);
  return found;
}

/**
 * Read + parse the project's manifest. Returns null if no manifest file is
 * present (so the caller can treat the repo as "not a Kortix project yet").
 * Throws on a YAML syntax error so the caller can surface it — we don't
 * silently swallow a malformed manifest.
 *
 * `kortix.yaml` wins over `kortix.yml`; a custom `manifest_path` keeps its
 * directory. The resolved file rides along on the ParsedManifest so the commit
 * path writes back to the exact same file.
 */
export async function readManifest(
  project: GitBackedProject,
  opts?: {
    forceRefresh?: MirrorRefresh;
    rethrowReadErrors?: boolean;
    /** Reuse this replica's last read while the default branch tip is unchanged. */
    reuseAtTip?: boolean;
  },
): Promise<ParsedManifest | null> {
  let found: ManifestRead;
  try {
    const candidates = manifestCandidatePaths(project.manifestPath);
    found = opts?.reuseAtTip
      ? await readManifestAtRemoteTip(project, candidates)
      : await readManifestFromRepo(project, candidates, project.defaultBranch, {
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
  const manifest = parseManifestString(found.content, found.path, found.sha, found.candidatePaths, found.commit);
  if (found.imports) manifest.imports = found.imports;
  if (found.legacy) {
    manifest.legacy = found.legacy;
    // `source` is the legacy text: never splice an edit into it.
    manifest.source = null;
  }
  return manifest;
}

/**
 * The agent name a synthesized (no-manifest-yet) manifest declares as its
 * default — same name `@kortix/starter`'s `base` template seeds (see
 * packages/starter/templates/base/kortix.yaml's `default_agent: worker` +
 * `agents.worker`). Keeping the two in sync means a blank managed-git project
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
export const SYNTHESIZED_DEFAULT_AGENT_NAME = 'worker';

/**
 * Build the synthesized manifest for a project with no kortix.yaml committed
 * yet: the starter's `worker` agent, granted everything, with the project
 * checkout. Pure (no I/O) — callers decide when a `null` `readManifest`
 * result should be treated as this shape.
 */
export function synthesizeBlankManifest(project: {
  name?: string;
  manifestPath?: string | null;
}): ParsedManifest {
  const candidatePaths = manifestCandidatePaths(project.manifestPath);
  return {
    raw: {
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
    path: candidatePaths[0] ?? MANIFEST_FILENAME,
    revision: null,
    candidatePaths,
  };
}

/**
 * Synchronous parse from a manifest string. Exported so the CRUD path can
 * round-trip (read existing string, parse, mutate, serialize) without touching
 * the network. Throws the YAML syntax error.
 */
export function parseManifestString(
  raw: string,
  path: string = MANIFEST_FILENAME,
  revision?: string | null,
  candidatePaths?: string[],
  commit?: string | null,
): ParsedManifest {
  // The yaml package's Document is lossless (comments + blank lines), so an
  // edit can be spliced back into `source`.
  const manifest: ParsedManifest = { raw: parseManifestText(raw), path, source: raw };
  if (revision !== undefined) manifest.revision = revision;
  if (candidatePaths !== undefined) manifest.candidatePaths = candidatePaths;
  if (commit !== undefined) manifest.commit = commit;
  return manifest;
}

/**
 * The manifest a running project applies, for the readers that keep state per
 * agent or trigger (grants, session start, the trigger runtime). Every agent
 * and trigger `usableManifest` turns off or drops is `enabled: false`, and a
 * `default_agent` it resets is removed. Nothing is deleted: a reader that
 * reconciles rows never prunes one on a typo, and an agent roster never reads
 * as "no agents declared" (which means ungoverned). `issues` are the
 * validator's errors, so a refusal can name them.
 */
export function runtimeManifest(manifest: ParsedManifest): ParsedManifest & { issues: ManifestIssue[] } {
  // The root text carries line numbers; a merged `imports:` document, and a converted legacy file, have none to give.
  const { issues } = validateManifest(!manifest.imports && !manifest.legacy && typeof manifest.source === 'string' ? manifest.source : manifest.raw);
  const usable = usableManifest(manifest.raw, issues);
  const raw = structuredClone(manifest.raw);
  const on = (entry: unknown) => isTable(entry) && entry.enabled !== false;
  const usableAgents = isTable(usable.agents) ? usable.agents : {};
  if (isTable(raw.agents)) {
    for (const [name, block] of Object.entries(raw.agents)) {
      if (isTable(block) && !on(usableAgents[name])) block.enabled = false;
    }
  }
  const usableTriggers = Array.isArray(usable.triggers) ? usable.triggers : [];
  if (Array.isArray(raw.triggers)) {
    raw.triggers.forEach((entry, index) => {
      if (isTable(entry) && !on(usableTriggers[index])) entry.enabled = false;
    });
  }
  if (usable.default_agent === undefined) delete raw.default_agent;
  return { ...manifest, raw, issues: issues.filter((issue) => issue.severity === 'error') };
}

/** Up to 3 issues as one sentence (`Fix kortix.yaml: agents.x.tools (line 4): …; +2 more.`). Empty for none. */
export function manifestIssueSummary(issues: readonly ManifestIssue[], file: string = MANIFEST_FILENAME): string {
  if (issues.length === 0) return '';
  const shown = issues.slice(0, 3).map((issue) => `${issue.path}${issue.line ? ` (line ${issue.line})` : ''}: ${issue.message.replace(/\.$/, '')}`);
  const more = issues.length > shown.length ? `; +${issues.length - shown.length} more` : '';
  return `Fix ${file}: ${shown.join('; ')}${more}.`;
}

/**
 * The errors `after` has that `before` does not (path + message). A Kortix
 * write is refused only for these: a file that already carries an error stays
 * editable, and no edit may add one. `after` is checked as it is written,
 * without `kortix_version`: a retired-format file is refused until its body
 * is valid.
 */
export function addedManifestErrors(before: Record<string, unknown>, after: Record<string, unknown>): ManifestIssue[] {
  const key = (issue: ManifestIssue) => `${issue.path}\u0000${issue.message}`;
  const existing = new Set(validateManifest(before).issues.filter((i) => i.severity === 'error').map(key));
  const { kortix_version: _obsolete, ...written } = after;
  return validateManifest(written).issues.filter((issue) => issue.severity === 'error' && !existing.has(key(issue)));
}

/** Serialize a parsed manifest back to text for committing. `kortix_version` is never written. */
export function serializeManifest(manifest: ParsedManifest): string {
  const { kortix_version: _obsolete, ...out } = manifest.raw;
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
  if (typeof manifest.source === 'string' && Array.isArray(out.triggers)) {
    // A write saves the latest shape: every deprecated shape is rewritten, comments kept.
    const source = fixManifestText(manifest.source).text;
    const spliced = spliceTriggerEntriesIntoYaml(out, source);
    if (spliced !== null) return spliced;
  }
  // Any other edit is written into the file's own text: comments and untouched lines keep their bytes.
  if (typeof manifest.source === 'string') {
    const rewritten = rewriteManifestText(manifest.source, out);
    if (rewritten !== null) return rewritten;
  }
  return serializeManifestObject(out);
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
    const written = canonicalize(parseYaml(text));
    const expected = canonicalize(parseYaml(stringifyYaml(desired)));
    return isDeepStrictEqual(written, expected) ? text : null;
  } catch {
    return null;
  }
}

/** What one manifest edit commits: the file(s) to write, plus the imported
 *  files that must be unchanged for the write to be safe. */
export interface ManifestWrites {
  files: Array<{ path: string; content: string }>;
  alsoExpect: Array<{ path: string; sha: string }>;
  /** Files the same commit removes: the `kortix.toml` a healed legacy manifest replaces. */
  deletes: string[];
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
  // A legacy file's first write saves the latest shape: `kortix.toml` becomes `kortix.yaml`,
  // and each prompt file loses its frontmatter (the overlay). Harness files left behind are no longer read.
  const rootPath = (manifest.path || fallbackPath || MANIFEST_FILENAME).replace(/\.toml$/i, manifest.legacy ? '.yaml' : '.toml');
  const healed = manifest.legacy ? Object.entries(manifest.legacy.overlay).map(([path, content]) => ({ path, content })) : [];
  // The same conversion `kortix validate --fix` writes: the replaced files go in this commit.
  const written = new Set([rootPath, ...healed.map((file) => file.path)]);
  const deletes = (manifest.legacy?.deletes ?? []).filter((path) => !written.has(path));
  // A healed legacy root is written exactly as `kortix validate --fix` writes it.
  const rootContent = (raw: Record<string, unknown>) => (manifest.legacy ? renderManifest(raw) : serializeManifest({ ...manifest, raw }));
  if (!manifest.imports) {
    return { files: [{ path: rootPath, content: rootContent(manifest.raw) }, ...healed], alsoExpect: [], deletes };
  }
  const [root, ...imported] = splitManifestByOrigin(manifest.imports, manifest.raw);
  const files: ManifestWrites['files'] = [];
  const changedImports = imported.filter((file) => file.changed);
  if (root && (root.changed || changedImports.length === 0)) {
    files.push({ path: rootPath, content: rootContent(root.raw) });
  }
  for (const file of changedImports) {
    const text = manifest.imports.files.find((source) => source.path === file.path)?.text;
    const rewritten = typeof text === 'string' ? rewriteManifestText(text, file.raw) : null;
    files.push({ path: file.path, content: rewritten ?? serializeManifestObject(file.raw) });
  }
  files.push(...healed);
  const alsoExpect = imported.flatMap((file) =>
    typeof file.revision === 'string' ? [{ path: file.path, sha: file.revision }] : [],
  );
  return { files, alsoExpect, deletes };
}
