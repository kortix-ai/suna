/**
 * Poll policy for the project-sessions list.
 *
 * The list polls while a session is still coming up (queued, branching,
 * provisioning) so its row flips to running. A row stuck in one of those
 * states would otherwise poll forever, so the poll stops 4 min after it
 * started for the current set of pending rows, like the connect loop.
 */

export const PROJECT_SESSIONS_POLL_MS = 3_000;
export const PROJECT_SESSIONS_POLL_MAX_MS = 4 * 60_000;

const PENDING_STATUSES = new Set(['queued', 'branching', 'provisioning']);

interface PollRow {
  session_id: string;
  status: string;
}

/** The poll window of one set of pending rows. */
export interface ProjectSessionsPollWindow {
  /** Sorted, comma-joined session ids of the pending rows. */
  key: string;
  startedAt: number;
}

function pendingKey(rows: readonly PollRow[] | undefined): string {
  if (!rows) return '';
  return rows
    .filter((row) => PENDING_STATUSES.has(row.status))
    .map((row) => row.session_id)
    .sort()
    .join(',');
}

/**
 * The poll window for `rows`: `null` without pending rows, `prev` while the
 * same rows stay pending, otherwise a new window that starts at `now`.
 */
export function nextProjectSessionsPollWindow(
  prev: ProjectSessionsPollWindow | null,
  rows: readonly PollRow[] | undefined,
  now: number
): ProjectSessionsPollWindow | null {
  const key = pendingKey(rows);
  if (!key) return null;
  if (prev?.key === key) return prev;
  return { key, startedAt: now };
}

/** React Query `refetchInterval` for the project-sessions list. */
export function projectSessionsPollInterval(
  rows: readonly PollRow[] | undefined,
  pollStartedAt: number,
  now: number
): number | false {
  if (!rows?.some((row) => PENDING_STATUSES.has(row.status))) return false;
  if (now - pollStartedAt >= PROJECT_SESSIONS_POLL_MAX_MS) return false;
  return PROJECT_SESSIONS_POLL_MS;
}
