/**
 * The session actions sheet's rules (COR-148) — pure, so every rule has a test.
 *
 * `SessionActionsSheet` puts three rows above Rename · Share · …:
 *   1. Open change request — `OpenCRSheet` prefilled with the session's
 *      branch (`branch_name` → `base_ref`). A project API call, so it works
 *      for any session that carries its own branch.
 *   2. View changes — the session's diff, read from the runtime's
 *      `/vcs/diff?mode=branch` (web `useSessionChanges`: the working tree plus
 *      every commit this branch carries over its base). Needs the live
 *      runtime, so only the open thread shows it.
 *   3. Compact — the OpenCode summarize call (`useCompactSession`). Needs the
 *      live runtime, and never runs while the session works.
 *
 * No React / React Native import.
 */

// ─── Changes ─────────────────────────────────────────────────────────────────

export type ChangeStatus = 'added' | 'deleted' | 'modified';

/** One entry of the runtime's `/vcs/diff` answer (OpenCode `VcsFileDiff`). */
export interface VcsFileChange {
  file: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: ChangeStatus;
}

export interface ChangedFile {
  /** Repository-relative path, e.g. `src/app/page.tsx`. */
  path: string;
  /** The part you read: `page.tsx`. */
  name: string;
  /** The part you skim: `src/app`. Empty at the repository root. */
  dir: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  /** The file's unified diff. Empty for a binary or an oversized file. */
  patch: string;
}

export interface ChangesSummary {
  files: ChangedFile[];
  count: number;
  additions: number;
  deletions: number;
}

const STATUSES: readonly ChangeStatus[] = ['added', 'deleted', 'modified'];

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Splits `src/app/page.tsx` into `{ name: 'page.tsx', dir: 'src/app' }`. */
export function splitChangePath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  if (slash < 0) return { name: path, dir: '' };
  return { name: path.slice(slash + 1) || path, dir: path.slice(0, slash) };
}

/**
 * The runtime's answer → the sheet's list. Tolerates a malformed body (the
 * endpoint is a runtime proxy): anything that is not an array is no changes,
 * entries without a path are dropped, a path listed twice keeps its first
 * entry. Sorted by path, so the list never reorders between two reads.
 */
export function summarizeSessionChanges(raw: unknown): ChangesSummary {
  const files: ChangedFile[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw as Partial<VcsFileChange>[]) {
      const path = typeof entry?.file === 'string' ? entry.file.trim() : '';
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const status = STATUSES.includes(entry.status as ChangeStatus)
        ? (entry.status as ChangeStatus)
        : 'modified';
      files.push({
        path,
        ...splitChangePath(path),
        status,
        additions: count(entry.additions),
        deletions: count(entry.deletions),
        patch: typeof entry.patch === 'string' ? entry.patch : '',
      });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files, count: files.length, additions, deletions };
}

/** "1 file" / "3 files". */
export function changedFilesLabel(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}

/**
 * The file's patch in the shape `PatchDiffView` parses: it splits on
 * `diff --git a/… b/…` headers. A patch without one (OpenCode builds some
 * with the `diff` library: `Index:` / `===` / `---` / `+++`) gets it, so the
 * hunks are not dropped.
 */
export function patchForFile(file: Pick<ChangedFile, 'path' | 'patch'>): string {
  const patch = file.patch;
  if (!patch.trim()) return '';
  if (/^diff --git /m.test(patch)) return patch;
  return `diff --git a/${file.path} b/${file.path}\n${patch}`;
}

// ─── Rows ────────────────────────────────────────────────────────────────────

/** Is the sheet's session the thread on screen? The tab store keys a thread by
 *  its OpenCode id; ProjectScreen resolves a row by either id, so this does too. */
export function isOpenThreadSession(
  session: { session_id: string; opencode_session_id: string | null },
  activeSessionId: string | null,
): boolean {
  if (!activeSessionId) return false;
  return session.opencode_session_id === activeSessionId || session.session_id === activeSessionId;
}

export interface OpenChangeRequestPrefill {
  headRef: string;
  baseRef: string;
  title: string;
}

/**
 * The Open change request sheet's starting values, or `null` when the session
 * has no branch of its own to propose (no branch, or it works on its base).
 */
export function openChangeRequestPrefill(
  session: { branch_name: string | null | undefined; base_ref: string | null | undefined },
  title: string,
): OpenChangeRequestPrefill | null {
  const headRef = session.branch_name?.trim() ?? '';
  const baseRef = session.base_ref?.trim() ?? '';
  if (!headRef || headRef === baseRef) return null;
  return { headRef, baseRef, title: title.trim() };
}

export interface ActionRowState {
  visible: boolean;
  /** A disabled row stays visible, dimmed, and ignores taps. */
  enabled: boolean;
  /** Trailing muted text: a count, or why the row is disabled. */
  value?: string;
}

export interface SessionActionRowsInput {
  /** The sheet's session is the thread on screen. */
  isOpenThread: boolean;
  /** The thread's runtime is reachable (the sandbox URL is known). */
  hasRuntime: boolean;
  /** The viewer may manage the session (`can_manage_lifecycle !== false`). */
  canManageLifecycle: boolean;
  hasBranch: boolean;
  changes: { pending: boolean; error: boolean; count: number };
  /** The session is working (`busy` or `retry`). */
  busy: boolean;
  /** A compaction of this session is running. */
  compacting: boolean;
}

export interface SessionActionRows {
  openChangeRequest: ActionRowState;
  viewChanges: ActionRowState;
  compact: ActionRowState;
}

const HIDDEN: ActionRowState = { visible: false, enabled: false };

export function sessionActionRows(input: SessionActionRowsInput): SessionActionRows {
  const live = input.isOpenThread && input.hasRuntime;

  const openChangeRequest: ActionRowState = input.hasBranch
    ? { visible: true, enabled: true }
    : HIDDEN;

  let viewChanges: ActionRowState = HIDDEN;
  if (live) {
    const { pending, error, count: n } = input.changes;
    // Unknown (loading) and failed reads stay tappable: the pushed view shows
    // the loader or the error with Try again. Only a read that says zero disables.
    if (pending || error) viewChanges = { visible: true, enabled: true };
    else if (n === 0) viewChanges = { visible: true, enabled: false, value: 'No changes' };
    else viewChanges = { visible: true, enabled: true, value: changedFilesLabel(n) };
  }

  let compact: ActionRowState = HIDDEN;
  if (live && input.canManageLifecycle) {
    if (input.compacting) compact = { visible: true, enabled: false, value: 'Compacting…' };
    else if (input.busy) compact = { visible: true, enabled: false, value: 'Working' };
    else compact = { visible: true, enabled: true };
  }

  return { openChangeRequest, viewChanges, compact };
}
