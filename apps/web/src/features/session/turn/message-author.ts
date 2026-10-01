import type { SessionMessageAuthor, SessionMessageAuthors } from '@kortix/sdk';

/** One author, one key: two members never share it, nor do two sessions. */
export function authorKey(author: SessionMessageAuthor): string {
  return author.kind === 'member' ? `member:${author.user_id}` : `session:${author.session_id}`;
}

export interface TranscriptAuthors {
  /** The author of each user message that has one, by runtime message id. */
  byMessage: Map<string, SessionMessageAuthor>;
  /** True when the transcript reads as a group chat: 2+ distinct authors. */
  multiAuthor: boolean;
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
  const distinct = new Set([...byMessage.values()].map(authorKey));
  return { byMessage, multiAuthor: distinct.size >= 2 };
}

/**
 * Whether a bubble names its author. A one-person session draws no name. A
 * group chat names every author, and so does a session you read that someone
 * else wrote in.
 */
export function showAuthorName(
  author: SessionMessageAuthor | undefined,
  multiAuthor: boolean,
  viewerId: string | undefined,
): boolean {
  if (!author) return false;
  if (multiAuthor) return true;
  return author.kind === 'session' || author.user_id !== viewerId;
}

/** A prompt an agent will answer. A `no_reply` prompt runs no turn. */
export function awaitsAgent(prompt: { no_reply?: boolean }): boolean {
  return !prompt.no_reply;
}
