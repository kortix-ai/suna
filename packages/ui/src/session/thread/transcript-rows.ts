'use client';

import type { SESSION_NOTICE } from '@kortix/sdk';
import { createContext, type ReactNode } from 'react';

/** Who wrote a row: an agent by name, or a person (by user id when known). */
export type TranscriptAuthor =
  | { kind: 'agent'; name: string }
  | { kind: 'person'; userId: string | null; name: string; email: string | null; avatarUrl: string | null };

/**
 * Set, the transcript draws every turn as message rows (avatar, name, time,
 * body), the way a channel thread reads: the prompt as its author's row, the
 * answer as the agent's row with its work folded behind one line. Unset, it
 * draws the session's own bubbles. A channel's thread panel sets it.
 */
export interface TranscriptRows {
  /** The agent's display name, on every answer row. */
  agent: string;
  /** The agent's raw name, the slug of its pixel mark. Unset: the default agent (`kortix`). */
  agentSlug?: string;
  /** The thread's starter: the author of a prompt with no recorded author. */
  owner: { id?: string | null; name: string | null; email: string | null; avatarUrl: string | null } | null;
  /**
   * Wraps a row's avatar and its name, once each (the space view's person
   * and agent card). Unset: they render bare.
   */
  author?: (who: TranscriptAuthor, node: ReactNode, part: 'avatar' | 'name') => ReactNode;
  /** The name of a prompt whose author nobody recorded and with no owner ("Someone"). */
  unknownAuthor: string;
  /**
   * The composer's computer notices in the host's words, by `SESSION_NOTICE`
   * key: a channel thread says "this thread's computer", not "session".
   */
  notices?: Partial<Record<keyof typeof SESSION_NOTICE, string>>;
  /**
   * Only messages: the person's prompts and the agent's words, plus the
   * deliverables it shows on purpose (`show`, `image_gen`). No "Worked for"
   * row, no tool, thinking or sub-agent rows, no notice or peer-message rows,
   * and no agent row for a settled turn that said nothing. While the turn
   * works, its row is "Kortix is typing…" (`TypingIndicator`). Each agent
   * message with work behind it carries "Show work", which opens that work
   * inline. A space's thread panel sets it with the `chat` flag on; the full
   * session still shows every step.
   */
  messagesOnly?: boolean;
  /**
   * A talk-only thread (`chat_front`, session metadata `kortix_front`): its
   * agent only talks and hands the work to worker sessions. "Show work"
   * opens the workers the message's turn started or answers, as read-only
   * transcripts, not the turn's own hand-off calls.
   */
  front?: boolean;
  /** The stuck-boot restart button in the host's terms ("Restart thread"). */
  labels?: {
    restart: string;
  };
}

export const TranscriptRowsContext = createContext<TranscriptRows | null>(null);
