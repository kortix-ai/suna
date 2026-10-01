/**
 * asked-you — conversations with people, for the drawer's "Asked you" group. Port of web's
 * `project-sidebar/asked-you.ts`: mobile does not import `apps/web`.
 *
 * The server stamps `metadata.participants` (user ids), `metadata.awaiting_reply`
 * and `metadata.awaiting_reply_from`; `metadata` is jsonb, so every read proves
 * its type. Rows come from `GET …/sessions?participant=me`.
 *
 * Pure data and pure functions only — unit-tested under `bun test`.
 */

import type { ProjectSession } from '@/lib/projects/projects-client';

type WithMetadata = Pick<ProjectSession, 'metadata'>;

function participantIds(session: WithMetadata): string[] {
  const raw = session.metadata?.participants;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
}

/** How many people a conversation was opened with. 0 = an ordinary session. */
export function sessionParticipantCount(session: WithMetadata): number {
  return participantIds(session).length;
}

/**
 * The conversation still waits for the viewer's own reply. In a group each
 * person stays owed until THEY reply (`awaiting_reply_from`); a conversation
 * from before that list existed falls back to the shared flag.
 */
export function sessionAwaitsViewer(session: WithMetadata, viewerId: string | null): boolean {
  if (viewerId === null || session.metadata?.awaiting_reply !== true) return false;
  const owed = session.metadata?.awaiting_reply_from;
  return Array.isArray(owed) ? owed.includes(viewerId) : participantIds(session).includes(viewerId);
}

/** Waiting conversations first; the served (activity) order holds inside each group. */
export function orderAskedYou(
  sessions: readonly ProjectSession[],
  viewerId: string | null,
): ProjectSession[] {
  const waiting = sessions.filter((s) => sessionAwaitsViewer(s, viewerId));
  const answered = sessions.filter((s) => !sessionAwaitsViewer(s, viewerId));
  return [...waiting, ...answered];
}

/**
 * Who asked. The server stamps `metadata.asked_by` on every ask: the asking
 * session's agent, else its title (`kind: 'session'`), or the person's name. Rows from before it
 * existed fall back to the run's starter, copied onto every child.
 */
export function askedYouAsker(
  session: Pick<ProjectSession, 'metadata' | 'initiator' | 'owner_name' | 'owner_email'>,
): string | null {
  const by = session.metadata?.asked_by;
  if (by && typeof by === 'object') {
    const { kind, name, email, agent } = by as { kind?: unknown; name?: unknown; email?: unknown; agent?: unknown };
    const label = kind === 'person' ? name || email : agent || name;
    if (typeof label === 'string' && label.trim()) return label;
  }
  return session.initiator?.label || session.owner_name || session.owner_email || null;
}

export interface AskedYouRow {
  session: ProjectSession;
  /** Waits for the viewer's reply: the row carries the `needs-you` mark. */
  waiting: boolean;
  /** "from <asker>", or null when the row names nobody. */
  from: string | null;
}

export interface AskedYouState {
  rows: AskedYouRow[];
  /** Session ids in the group: the rest of the list leaves them out. */
  ids: ReadonlySet<string>;
}

const EMPTY: AskedYouState = { rows: [], ids: new Set() };

/** The group's derived state. Absent while empty (`rows.length === 0`). */
export function askedYouState(
  sessions: readonly ProjectSession[],
  viewerId: string | null,
): AskedYouState {
  if (sessions.length === 0) return EMPTY;
  const rows = orderAskedYou(sessions, viewerId).map((session) => {
    const asker = askedYouAsker(session);
    return {
      session,
      waiting: sessionAwaitsViewer(session, viewerId),
      from: asker ? `from ${asker}` : null,
    };
  });
  return { rows, ids: new Set(rows.map((r) => r.session.session_id)) };
}
