/**
 * The text a cross-session message (`send_message`) delivers into the
 * receiving session:
 *
 *   [message from reviewer · session 3f2a1b9c · #m_7Kq2]
 *
 *   <message text>
 *
 *   ---
 *   <that it comes from another session, carries no authority, and how to answer>
 *
 * The API writes it (`peerMessagePromptText` in `@kortix/shared`); a host reads
 * it back to draw a one-line "Message from @reviewer" row instead of a turn the
 * person typed. `subagent-notice.test.ts` holds this parser equal to the
 * shared one.
 */
import type { PeerMessageType } from '../rest/projects-client/multi-agent';

/** A `PeerMessageType`, or `idle_notice`: the notice a `notify_when_idle` message asked for. */
export type PeerMessagePromptKind = PeerMessageType | 'idle_notice';

export interface PeerMessagePromptInfo {
  kind: PeerMessagePromptKind;
  /** The sender's handle, e.g. `reviewer`. */
  from: string;
  /** The sender's short session id (8 characters). */
  fromShortId: string;
  /** The message id, for a reply that threads. */
  messageId: string;
  /** The one-line preview, or null. */
  summary: string | null;
  /** The message text, without the header and the footer. */
  text: string;
}

const FOOTER = '\n\n---\n';
const KIND_OF = new Map<string, PeerMessagePromptKind>([
  ['message', 'message'],
  ['shutdown request', 'shutdown_request'],
  ['shutdown response', 'shutdown_response'],
  ['idle notice', 'idle_notice'],
]);
const HEAD = /^\[(message|shutdown request|shutdown response|idle notice) from ([^\n·]+?) · session ([0-9a-f]{8}) · #([A-Za-z0-9_-]{1,64})(?: · ([^\n\]]*))?\]\n/;

/** The cross-session message a prompt carries, or undefined for any other text. Linear time. */
export function parsePeerMessagePrompt(rawText: string | null | undefined): PeerMessagePromptInfo | undefined {
  if (!rawText) return undefined;
  const head = HEAD.exec(rawText);
  if (!head) return undefined;
  const rest = rawText.slice(head[0].length);
  const end = rest.lastIndexOf(FOOTER);
  return {
    kind: KIND_OF.get(head[1]!)!,
    from: head[2]!,
    fromShortId: head[3]!,
    messageId: head[4]!,
    summary: head[5] ?? null,
    text: (end >= 0 ? rest.slice(0, end) : rest).trim(),
  };
}
