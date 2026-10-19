/**
 * Pure parts of conversations: who a message mentions, when agents have talked
 * among themselves long enough, and the text a member session receives.
 */
import { roomPromptText } from '@kortix/shared';

/** Consecutive session-sent messages after which deliveries to sessions stop until a person posts. */
export const AGENT_CHAIN_LIMIT = 20;

/** The `@` tokens in a message, lowercased: `@3f2a1b9c`, `@builder`, `@all`. */
export function mentionTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9._-]{1,63})/gi)) out.add(match[1]!.toLowerCase());
  return out;
}

/**
 * True when `tokens` names this member: `@all`/`@here`, 8 or more leading
 * characters of one of its `ids` (a session id or a user id), or one of its
 * `names` written as a slug (`Fix CI` → `@fix-ci`).
 */
export function mentionsMember(tokens: Set<string>, member: { ids: readonly string[]; names: readonly string[] }): boolean {
  if (tokens.has('all') || tokens.has('here')) return true;
  for (const id of member.ids) {
    const lower = id.toLowerCase();
    for (const token of tokens) if (token.length >= 8 && lower.startsWith(token)) return true;
  }
  return member.names.some((name) => {
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-');
    return !!slug && tokens.has(slug);
  });
}

/** True when the last `limit` messages (newest first) all came from sessions: agents talking among themselves. */
export function agentChainReached(recentSenderKinds: readonly string[], limit = AGENT_CHAIN_LIMIT): boolean {
  return recentSenderKinds.length >= limit && recentSenderKinds.slice(0, limit).every((kind) => kind === 'session');
}

/** The text a member session receives (`@kortix/shared` room-prompt owns the format). */
export function roomMessagePrompt(input: {
  room: { kind: 'room' | 'direct'; name: string | null; roomId: string };
  seq: number;
  senderKind: 'member' | 'session';
  senderLabel: string;
  text: string;
  replyToSeq: number | null;
  roomProjectId?: string | null;
}): string {
  return roomPromptText({
    kind: input.room.kind,
    room: input.room.name,
    roomId: input.room.roomId,
    seq: input.seq,
    senderKind: input.senderKind,
    sender: input.senderLabel,
    replyTo: input.replyToSeq,
    text: input.text,
    roomProjectId: input.roomProjectId,
  });
}
