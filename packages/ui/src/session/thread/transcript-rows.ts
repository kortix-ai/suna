'use client';

import { createContext } from 'react';

/**
 * Set, the transcript draws every turn as message rows (avatar, name, time,
 * body), the way a channel thread reads: the prompt as its author's row, the
 * answer as the agent's row with its work folded behind one line. Unset, it
 * draws the session's own bubbles. A channel's thread panel sets it.
 */
export interface TranscriptRows {
  /** The agent's display name, on every answer row. */
  agent: string;
  /** The thread's starter: the author of a prompt with no recorded author. */
  owner: { name: string | null; email: string | null; avatarUrl: string | null } | null;
  /** The name of a prompt whose author nobody recorded and with no owner ("Someone"). */
  unknownAuthor: string;
}

export const TranscriptRowsContext = createContext<TranscriptRows | null>(null);
