import {
  sessionParentId,
  type ProjectSession,
  type SessionsNeedingInputResponse,
} from '@kortix/sdk';

/**
 * Conversations with people (project feature flag `human_messaging`).
 * The server stamps `metadata.participants` (user ids) and
 * `metadata.awaiting_reply`; these helpers read that bag safely (it is jsonb).
 */

function participantIds(session: Pick<ProjectSession, 'metadata'>): string[] {
  const raw = session.metadata?.participants;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
}

/** How many people a conversation was opened with. 0 = an ordinary session. */
export function sessionParticipantCount(session: Pick<ProjectSession, 'metadata'>): number {
  return participantIds(session).length;
}

/** The conversation still waits for the viewer's own reply. In a group each
 *  person stays owed until THEY reply (`awaiting_reply_from`); a conversation
 *  from before that list existed falls back to the shared flag. */
export function sessionAwaitsViewer(
  session: Pick<ProjectSession, 'metadata'>,
  viewerId: string | null,
): boolean {
  if (viewerId === null || session.metadata?.awaiting_reply !== true) return false;
  const owed = session.metadata?.awaiting_reply_from;
  return Array.isArray(owed) ? owed.includes(viewerId) : participantIds(session).includes(viewerId);
}

/** Waiting conversations first; the served (activity) order holds inside each group. */
export function orderAskedYou(sessions: readonly ProjectSession[], viewerId: string | null) {
  const waiting = sessions.filter((s) => sessionAwaitsViewer(s, viewerId));
  const answered = sessions.filter((s) => !sessionAwaitsViewer(s, viewerId));
  return [...waiting, ...answered];
}

/** Who asked. The run's starter is copied onto every child, so this is the person behind the ask. */
export function askedYouAsker(
  session: Pick<ProjectSession, 'initiator' | 'owner_name' | 'owner_email'>,
): string | null {
  return session.initiator?.label || session.owner_name || session.owner_email || null;
}

/**
 * Review counts plus the server's "waiting on a human" counts (connector
 * approvals and open agent questions the viewer may answer), by session id.
 * Feeds the one `needs-you` status mark.
 */
export function mergeNeedsYou(
  review: Record<string, number>,
  needsInput: SessionsNeedingInputResponse | undefined,
): Record<string, number> {
  if (!needsInput || needsInput.total <= 0) return review;
  const merged = { ...review };
  for (const [sessionId, count] of Object.entries(needsInput.sessions)) {
    merged[sessionId] = (merged[sessionId] ?? 0) + count;
  }
  return merged;
}

/** Waiting conversations not yet in `seen`: the ones worth one toast. */
export function newlyAwaiting(
  sessions: readonly ProjectSession[],
  viewerId: string | null,
  seen: ReadonlySet<string>,
): ProjectSession[] {
  return sessions.filter((s) => sessionAwaitsViewer(s, viewerId) && !seen.has(s.session_id));
}

/** The people a conversation was opened with, for the session header. */
export function sessionPeople(
  session: Pick<ProjectSession, 'participant_people'>,
): Array<{ id: string; label: string; email: string | null }> {
  return (session.participant_people ?? []).flatMap((p) => {
    const label = p.name || p.email;
    return label ? [{ id: p.user_id, label, email: p.email }] : [];
  });
}

/** The session that asked, when this session is a conversation with people. */
export function askedFromParentId(
  session: Pick<ProjectSession, 'session_id' | 'metadata' | 'parent_session_id'>,
): string | null {
  return sessionParticipantCount(session) > 0 ? sessionParentId(session) : null;
}
