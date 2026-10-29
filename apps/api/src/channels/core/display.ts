/**
 * Words and links every chat platform shows for a session: its status, its age
 * and its page in Kortix. No imports: a platform's renderer and the core both
 * read these.
 */

/**
 * Every value of `project_session_status`, as a glyph and a word a user reads.
 *
 * The first cut of this map keyed on `idle`, which is not one of them — so it
 * never matched, and `queued`, `branching`, `provisioning` and `completed` all
 * fell through to a bare `•`. The enum is the contract
 * (packages/db/src/schema/kortix.ts): queued, branching, provisioning, running,
 * stopped, failed, completed.
 *
 * `branching` and `provisioning` are how the sandbox is built, not something a
 * user asked about; both read as "starting". A status outside the enum still
 * renders, verbatim, rather than being swallowed.
 */
export const SESSION_STATUS: Record<string, { glyph: string; label: string }> = {
  queued: { glyph: '•', label: 'queued' },
  branching: { glyph: '•', label: 'starting' },
  provisioning: { glyph: '•', label: 'starting' },
  running: { glyph: '⏳', label: 'working' },
  completed: { glyph: '✓', label: 'done' },
  stopped: { glyph: '•', label: 'stopped' },
  failed: { glyph: '✗', label: 'failed' },
};

/**
 * A session's status row: `<glyph> <word> · started <age>`, or `opts.none` with no session.
 * `turnRunning` undefined: the status alone. True: working. False on a `running` session: ready.
 */
export function describeSession(
  session: { status: string | null; createdAt: Date | null } | null,
  opts: { none: string; turnRunning?: boolean },
): string {
  if (!session) return opts.none;
  const raw = session.status ?? '';
  const known = opts.turnRunning
    ? SESSION_STATUS.running
    : opts.turnRunning === false && raw === 'running'
      ? { glyph: '•', label: 'ready' }
      : SESSION_STATUS[raw];
  const when = session.createdAt ? ` · started ${formatRelativeTime(session.createdAt)}` : '';
  return `${known?.glyph ?? '•'} ${known?.label ?? raw}${when}`;
}

export function formatRelativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

/** Dashboard base URL (no trailing slash) for building project/session links. */
export function dashboardBase(kortixUrl?: string): string {
  return (kortixUrl || 'https://kortix.com').replace(/\/$/, '');
}

/** Web URL for a Kortix session. */
export function sessionWebUrl(kortixUrl: string | undefined, projectId: string, sessionId: string): string {
  return `${dashboardBase(kortixUrl)}/projects/${projectId}/sessions/${sessionId}`;
}

/** Web URL for a Kortix project. */
export function projectWebUrl(kortixUrl: string | undefined, projectId: string): string {
  return `${dashboardBase(kortixUrl)}/projects/${projectId}`;
}
