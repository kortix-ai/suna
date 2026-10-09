/**
 * The words and numbers every "changes" surface reads from.
 *
 * Three surfaces used to each hand-roll this: the session Changes tab, the
 * proposed-change dialog, and the session header popover. They drifted — the
 * same file was "Modified" in one, "Edited" in another — and each one leaked a
 * different amount of git into the product ("base ref", "unified", "merge",
 * "+3 M5 D4"). One module, one vocabulary, no git words that reach a screen.
 *
 * Pure on purpose: `apps/web` has no DOM test harness, so the decisions that
 * can actually be wrong live here where `bun test` can reach them.
 */

import type { StatusTone } from '@/components/ui/status';
import type { UiTranslator } from '@/i18n/translator';

// ---------------------------------------------------------------------------
// what happened to a file
// ---------------------------------------------------------------------------

/** The statuses git reports. Kept as the key; never shown to a reader. */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';

export interface ChangeKindMeta {
  /** The word a reader sees. Never "modified" — that is a git word. */
  label: string;
  tone: StatusTone;
}

export const CHANGE_KIND: Record<ChangeKind, ChangeKindMeta> = {
  added: { label: 'Added', tone: 'success' },
  modified: { label: 'Edited', tone: 'warning' },
  deleted: { label: 'Removed', tone: 'destructive' },
  renamed: { label: 'Renamed', tone: 'info' },
  copied: { label: 'Copied', tone: 'info' },
  typechange: { label: 'Edited', tone: 'warning' },
};

/**
 * Anything unrecognised reads as an edit. A file in a change list has changed
 * by definition, so "Edited" is the honest fallback — and it keeps an unknown
 * status from rendering a blank cell or a raw git word.
 */
export function changeKind(status: string | null | undefined): ChangeKindMeta {
  return CHANGE_KIND[status as ChangeKind] ?? CHANGE_KIND.modified;
}

// ---------------------------------------------------------------------------
// one changed file, from either source
// ---------------------------------------------------------------------------

/**
 * The shape every changes surface renders.
 *
 * Two APIs feed these screens and neither matches the other: the change-request
 * diff returns `ProjectCommitFile` (`path` / `status` / `old_path`), the live
 * session diff returns `VcsFileDiff` (`file` / optional `status` / `patch`).
 * Normalising at the edge is what lets one row component serve both.
 */
export interface ChangeEntry {
  /** Repo-relative path, e.g. `src/app/page.tsx`. */
  path: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
  /** Where a renamed or copied file came from. */
  fromPath?: string | null;
  /** Unified patch for this one file, when the source carries it. */
  patch?: string;
}

interface CommitFileLike {
  path: string;
  old_path?: string | null;
  status: string;
  additions: number;
  deletions: number;
}

interface VcsFileLike {
  file: string;
  status?: string | null;
  patch?: string;
  additions: number;
  deletions: number;
}

export function entryFromCommitFile(file: CommitFileLike, patch?: string): ChangeEntry {
  return {
    path: file.path,
    kind: (file.status as ChangeKind) ?? 'modified',
    additions: file.additions,
    deletions: file.deletions,
    fromPath: file.old_path ?? null,
    patch,
  };
}

export function entryFromVcsFile(file: VcsFileLike): ChangeEntry {
  return {
    path: file.file,
    kind: (file.status as ChangeKind) ?? 'modified',
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  };
}

// ---------------------------------------------------------------------------
// reading a path
// ---------------------------------------------------------------------------

/**
 * `src/app/page.tsx` → the part you read (`page.tsx`) and the part you skim
 * (`src/app`). Rows lead with the name at full contrast and trail the folder
 * dimmed, so a list of twelve files scans as twelve names, not twelve paths.
 */
export function splitPath(path: string): { name: string; dir: string } {
  const clean = path.replace(/\/+$/, '');
  const cut = clean.lastIndexOf('/');
  if (cut === -1) return { name: clean, dir: '' };
  return { name: clean.slice(cut + 1), dir: clean.slice(0, cut) };
}

// ---------------------------------------------------------------------------
// counting
// ---------------------------------------------------------------------------

export interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
}

export function totalChanges(entries: ChangeEntry[]): ChangeTotals {
  let additions = 0;
  let deletions = 0;
  for (const entry of entries) {
    additions += entry.additions;
    deletions += entry.deletions;
  }
  return { files: entries.length, additions, deletions };
}

/** `1 file` / `12 files`. The word "changed" is redundant in a changes list. */
export function fileCount(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// how the diff is laid out
// ---------------------------------------------------------------------------

export type DiffLayout = 'unified' | 'split';

/**
 * "Unified" and "Split" are diff-tool words. What a reader is choosing is
 * whether the old and new text sit on top of each other or next to each other.
 */
export const DIFF_LAYOUT_LABEL: Record<DiffLayout, string> = {
  unified: 'Stacked',
  split: 'Side by side',
};

/**
 * The width a diff needs before squashing it does more harm than scrolling it.
 *
 * Side by side is two code columns, so it needs ~860px; stacked is one, so
 * ~680px. Below that the viewport scrolls sideways rather than wrapping code
 * into unreadable ribbons — and above it the diff collapses to the container.
 */
export function diffViewportClass(layout: DiffLayout): string {
  return layout === 'split' ? 'min-w-[860px] lg:min-w-0' : 'min-w-[680px] sm:min-w-0';
}

// ---------------------------------------------------------------------------
// a proposed change
// ---------------------------------------------------------------------------

export type ProposedChangeStatus = 'open' | 'merged' | 'closed';

export interface ProposedChangeStateMeta {
  label: string;
  tone: StatusTone;
}

/**
 * An open proposal says "Waiting on you", not "Awaiting review" — the reader IS
 * the review, and the passive phrasing hid that the next move was theirs.
 */
export const PROPOSED_CHANGE_STATE: Record<ProposedChangeStatus, ProposedChangeStateMeta> = {
  open: { label: 'Waiting on you', tone: 'warning' },
  merged: { label: 'Applied', tone: 'success' },
  closed: { label: 'Dismissed', tone: 'neutral' },
};

/**
 * The one thing that happened to this proposal, and when — `Applied 2 hours
 * ago`. Callers pass their own relative formatter so this stays pure and the
 * date library choice stays at the call site.
 */
export function proposedChangeTimeline(
  cr: {
    status: ProposedChangeStatus;
    created_at: string;
    merged_at?: string | null;
    closed_at?: string | null;
  },
  relative: (iso: string) => string,
  tI18nComplete?: UiTranslator,
): string {
  if (cr.status === 'merged' && cr.merged_at) {
    const time = relative(cr.merged_at);
    return tI18nComplete ? tI18nComplete('text640afe0ce78c', { time }) : `Applied ${time}`;
  }
  if (cr.status === 'closed' && cr.closed_at) {
    const time = relative(cr.closed_at);
    return tI18nComplete ? tI18nComplete('text86c15f03c03a', { time }) : `Dismissed ${time}`;
  }
  const time = relative(cr.created_at);
  return tI18nComplete ? tI18nComplete('textf6eaf58e6b8a', { time }) : `Proposed ${time}`;
}

// ---------------------------------------------------------------------------
// splitting a whole-change patch into per-file patches
// ---------------------------------------------------------------------------

/**
 * The change-request API returns ONE unified patch for the whole change plus a
 * separate file list. Rendering the diff per row means cutting the patch on
 * each `diff --git` header and keying the pieces by the **new** path (the `b/`
 * side), which is the path the file list reports for everything except a
 * deletion — and a deletion's `b/` path is the same string anyway.
 *
 * Each chunk's quoted header lines are also rewritten to their decoded paths
 * (`unquotePatchHeaders`): the diff renderer parses only the unquoted form and
 * throws on the quoted one.
 */
export function splitUnifiedPatch(patch: string): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!patch.trim()) return byPath;

  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.trim()) continue;
    const path = patchChunkPath(chunk);
    if (path) byPath.set(path, unquotePatchHeaders(chunk));
  }
  return byPath;
}

/**
 * Rewrite a chunk's C-quoted header lines to plain decoded paths. The diff
 * renderer (@pierre/diffs) matches `---`/`+++`/`diff --git` lines with regexes
 * that only accept the unquoted `[ab]/<path>` form: a quoted path both crashes
 * its parser (TypeError on its own match groups) and, where it parses, shows
 * git's octal escapes as the file name. The quoted token already carries the
 * `a/`/`b/` prefix and an optional trailing TAB, so the decoded path replaces
 * the whole token. `/dev/null` and unquoted lines are left untouched.
 */
function unquotePatchHeaders(chunk: string): string {
  return chunk
    .replace(
      /^diff --git ("[ab]\/(?:[^"\\]|\\.)*") ("[ab]\/(?:[^"\\]|\\.)*")[ \t]*$/m,
      (_line, aToken: string, bToken: string) =>
        `diff --git ${unquoteGitPath(aToken)} ${unquoteGitPath(bToken)}`,
    )
    .replace(/^--- ("a\/(?:[^"\\]|\\.)*")[ \t]*$/m, (_line, token: string) => `--- ${unquoteGitPath(token)}`)
    .replace(/^\+\+\+ ("b\/(?:[^"\\]|\\.)*")[ \t]*$/m, (_line, token: string) => `+++ ${unquoteGitPath(token)}`);
}

/**
 * The file list comes from `git diff --name-status -z`, which reports raw
 * (unquoted) paths. Patch headers do not: git C-quotes non-ASCII paths (octal
 * UTF-8 bytes) and writes paths containing " b/" ambiguously. A chunk that
 * cannot be read back into a file-list path renders as an accordion with no
 * body (KRTX-2010), so the b-side is read the way git actually writes it:
 *
 * 1. `+++ b/<path>` — the post-image file. Unambiguous even when the path
 *    itself contains " b/", absent for pure renames, `/dev/null` for deletions.
 * 2. The `diff --git` header's quoted pair — unquoted byte-for-byte.
 * 3. The header's raw pair — split at the LAST ` b/`, because the old path may
 *    itself contain " b/" while the separator is the boundary git appended last.
 */
function patchChunkPath(chunk: string): string | null {
  // git writes `+++ b/<path>\t` — a TAB (plus an empty timestamp) trails the
  // path. A path never contains a raw TAB: git quotes control characters, so
  // cutting at the first one is safe.
  const plusLine = chunk.match(/^\+\+\+ (.+)$/m)?.[1]?.split('\t')[0];
  if (plusLine && plusLine.trim() !== '/dev/null') {
    return stripBPrefixed(unquoteGitPath(plusLine));
  }

  const header = chunk.match(/^diff --git (.+)$/m)?.[1];
  if (!header) return null;
  if (header.startsWith('"')) {
    const tokens = header.match(/"(?:[^"\\]|\\.)*"/g);
    const second = tokens?.[1];
    return second ? stripBPrefixed(unquoteGitPath(second)) : null;
  }
  const rest = header.replace(/^a\//, '');
  const separator = rest.lastIndexOf(' b/');
  return separator >= 0 ? rest.slice(separator + 3) : null;
}

/** `+++ b/src/x.ts` and the header's `b/` side both mark the path with git's
 *  `b/` prefix — one level, not part of the path itself. */
function stripBPrefixed(path: string): string {
  return path.startsWith('b/') ? path.slice(2) : path;
}

/** Decode the C-style string git wraps around a path it must quote
 *  (`"b/\321\204..."`): octal escapes are raw BYTES, the rest are characters,
 *  and only the byte re-assembly is allowed to be UTF-8-invalid mid-decode. */
function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const simpleEscapes: Record<string, number[]> = {
    a: [0x07], b: [0x08], f: [0x0c], n: [0x0a], r: [0x0d], t: [0x09], v: [0x0b],
    '"': [0x22], '\\': [0x5c],
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') {
      const octal = /^([0-7]{3})/.exec(body.slice(i + 1));
      if (octal) {
        bytes.push(parseInt(octal[1], 8));
        i += 3;
        continue;
      }
      const simple = simpleEscapes[body[i + 1]];
      if (simple) {
        bytes.push(...simple);
        i += 1;
        continue;
      }
    }
    bytes.push(...encoder.encode(ch));
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

/**
 * Which rows start open.
 *
 * Every row expanded is a wall of diff — the dialog used to render all of them
 * that way. Every row collapsed is a click per file. Opening the first one
 * shows the change immediately in the common case (an agent touching one or two
 * files) without ever painting thirty diffs at once.
 */
export function initiallyExpanded(entries: ChangeEntry[]): Set<string> {
  const first = entries[0];
  return first ? new Set([first.path]) : new Set<string>();
}

/**
 * Whether an expansion set should be re-seeded from scratch.
 *
 * The proposed-change dialog is REUSED between change requests, not remounted
 * — the same reason its merge error has to be gated on `variables === crId`.
 * A `useState` initializer runs once per mount, so without this the rows you
 * expanded on change A stay "expanded" in a set that change B's paths never
 * match, and B opens with everything collapsed.
 *
 * Seeding waits for the first non-empty list because the diff arrives after the
 * dialog does: seeding against `[]` would seed nothing and never retry.
 *
 * `seededFor` is `null` before the first seed; the key is normalised so a
 * caller that passes no key (a surface with only one subject, like the live
 * session diff) settles on `''` and never re-seeds itself in a loop.
 */
export function shouldReseedExpansion(
  seededFor: string | null,
  resetKey: string,
  entryCount: number,
): boolean {
  return entryCount > 0 && seededFor !== resetKey;
}
