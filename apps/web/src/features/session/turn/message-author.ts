import type { SessionMessageAuthor, SessionMessageAuthors } from '@kortix/sdk';
import { parseSessionMessagePrompt, type SessionMessagePromptInfo } from '@kortix/shared';

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

/** True when `info` is an ask that names the viewer, so the reply is theirs. */
export function isAskForViewer(
  info: SessionMessagePromptInfo | undefined,
  viewerEmail: string | undefined,
): boolean {
  if (info?.type !== 'ask' || !viewerEmail) return false;
  const me = viewerEmail.toLowerCase();
  return info.to.some((p) => p.email.toLowerCase() === me);
}

/** A prompt an agent will answer. An ask's first message is `no_reply`: it goes to people. */
export function awaitsAgent(prompt: { no_reply?: boolean }): boolean {
  return !prompt.no_reply;
}

/**
 * The newest turn is an ask no agent has answered. The ask went to people, so
 * the runtime's brief "busy" after delivering it is not an agent thinking.
 */
export function isUnansweredAsk(
  turn:
    | {
        userMessage: { parts: ReadonlyArray<{ type: string; text?: string }> };
        assistantMessages: ReadonlyArray<unknown>;
      }
    | undefined,
): boolean {
  if (!turn || turn.assistantMessages.length > 0) return false;
  const text = turn.userMessage.parts.find((p) => p.type === 'text')?.text;
  return parseSessionMessagePrompt(text)?.type === 'ask';
}
