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

// ---------------------------------------------------------------------------
// what happened to a file
// ---------------------------------------------------------------------------

/** The statuses git reports. Kept as the key; never shown to a reader. */
export type ChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange';

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
): string {
  if (cr.status === 'merged' && cr.merged_at) return `Applied ${relative(cr.merged_at)}`;
  if (cr.status === 'closed' && cr.closed_at) return `Dismissed ${relative(cr.closed_at)}`;
  return `Proposed ${relative(cr.created_at)}`;
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
 */
export function splitUnifiedPatch(patch: string): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!patch.trim()) return byPath;

  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.trim()) continue;
    const match = chunk.match(/^diff --git a\/(?:.*?) b\/(.+?)$/m);
    if (!match) continue;
    byPath.set(match[1], chunk);
  }
  return byPath;
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
