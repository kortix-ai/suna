import type { SessionMessageAuthor, SessionMessageAuthors, SessionParticipants } from '@kortix/sdk';

import type { UiViewer } from '../../providers/ui-provider';

interface TranscriptAuthors {
  /** The author of each user message that has one, by runtime message id. */
  byMessage: Map<string, SessionMessageAuthor>;
}

/**
 * Pairs each user message with its author. A spawned session's first message
 * has no prompt record of its own, so `initial_author` goes to the first user
 * message that has no author.
 */
export function resolveTranscriptAuthors(
  userMessageIds: readonly string[],
  data: SessionMessageAuthors | undefined,
): TranscriptAuthors {
  const byMessage = new Map<string, SessionMessageAuthor>();
  let initial = data?.initial_author ?? null;
  for (const id of userMessageIds) {
    const author = data?.authors[id] ?? initial;
    if (!author) continue;
    if (!data?.authors[id]) initial = null;
    byMessage.set(id, author);
  }
  return { byMessage };
}

/** When to ask again for an author that is not recorded yet: 2 s, 5 s, 12 s. */
export const AUTHOR_RETRY_DELAYS_MS = [2000, 5000, 12000];

/**
 * The wanted ids that have no author yet, sorted and joined: one key per set
 * of missing ids, so a retry schedule restarts when the set changes (a new
 * prompt) and ends when it does not. Empty before the first read.
 */
export function missingAuthorKey(data: SessionMessageAuthors | undefined, ids: readonly string[]): string {
  if (!data) return '';
  return ids.filter((id) => id && !data.authors[id]).sort().join(',');
}

/**
 * The author of one transcript turn. A delivered message keeps its pairing
 * from `resolveTranscriptAuthors`. A queued prompt is a turn the runtime
 * transcript does not hold yet, so it is looked up in the authors map
 * directly: by the turn's id, then by its prompt's wire id.
 */
export function authorForTurn(
  resolved: TranscriptAuthors,
  data: SessionMessageAuthors | undefined,
  messageId: string,
  wireMessageId?: string,
): SessionMessageAuthor | undefined {
  return (
    resolved.byMessage.get(messageId) ??
    data?.authors[messageId] ??
    (wireMessageId ? data?.authors[wireMessageId] : undefined)
  );
}

/**
 * The signed-in viewer as a message author. A prompt sent from this tab has no
 * recorded author until the ledger writes it, a moment after the bubble
 * paints: the viewer's own avatar stands in, so the bubble does not move when
 * the recorded author arrives. Undefined with no viewer.
 */
export function viewerAuthor(viewer: UiViewer | undefined): SessionMessageAuthor | undefined {
  if (!viewer) return undefined;
  const name = viewer.metadata?.full_name ?? viewer.metadata?.name;
  const avatar = viewer.metadata?.avatar_url;
  return {
    kind: 'member',
    user_id: viewer.id,
    name: typeof name === 'string' ? name : '',
    email: viewer.email ?? null,
    avatar_url: typeof avatar === 'string' ? avatar : null,
  };
}

/**
 * A queued prompt's sender, from the people who can open the session: the
 * prompt row names its `author_user_id` before the authors read lists it.
 * Undefined when that person is not in the listed rows (the route lists 20).
 */
export function participantAuthor(
  participants: SessionParticipants | undefined,
  userId: string | null | undefined,
): SessionMessageAuthor | undefined {
  const person = userId ? participants?.participants.find((p) => p.user_id === userId) : undefined;
  if (!person) return undefined;
  return {
    kind: 'member',
    user_id: person.user_id,
    name: person.name ?? '',
    email: person.email,
    avatar_url: person.avatar_url,
  };
}

/**
 * Who to name under a turn someone ELSE stopped: "Stopped by <name>". Null
 * when nobody is recorded, when the stop came from an agent session, and when
 * the viewer stopped it: a stop you asked for is not news. Null too with no
 * viewer id: the stopper may be the viewer.
 */
export function stoppedByName(
  data: SessionMessageAuthors | undefined,
  messageId: string,
  viewerId: string | undefined,
): string | null {
  const stopper = data?.stops?.[messageId];
  if (stopper?.kind !== 'member' || viewerId === undefined || stopper.user_id === viewerId) return null;
  return stopper.name || stopper.email || null;
}

/** A prompt an agent will answer. A `no_reply` prompt runs no turn. */
export function awaitsAgent(prompt: { no_reply?: boolean }): boolean {
  return !prompt.no_reply;
}

/**
 * The user messages the viewer may edit and rewind to: their own, with no
 * other person's message after it (a rewind deletes everything after the
 * target). An agent's message, or one with no recorded author, belongs to the
 * thread's starter and never blocks a later rewind. The server applies the same
 * rule (`rewind-authority.ts`). Null with no viewer id: nothing to filter on.
 */
export function rewindableMessageIds(
  messageIds: readonly string[],
  authors: ReadonlyMap<string, SessionMessageAuthor>,
  viewerId: string | undefined,
  starterId: string | null | undefined,
): Set<string> | null {
  if (viewerId === undefined) return null;
  const allowed = new Set<string>();
  for (let i = messageIds.length - 1; i >= 0; i--) {
    const author = authors.get(messageIds[i]!);
    if (author?.kind === 'member') {
      if (author.user_id !== viewerId) break;
      allowed.add(messageIds[i]!);
    } else if (!starterId || starterId === viewerId) {
      allowed.add(messageIds[i]!);
    }
  }
  return allowed;
}
