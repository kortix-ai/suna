/**
 * Which session a transcript draws: rows that read more than their own part (an
 * `agent` call's live child, a workflow card's live run) take the ids from here
 * instead of threading them through every `Turn`.
 *
 * `Transcript` and the peek provide it. Outside a provider the ids are null and
 * those rows draw from their part alone.
 */

import { type ReactNode, createContext, useContext, useMemo } from 'react';

export interface TranscriptSession {
  projectId: string | null;
  sessionId: string | null;
}

const NONE: TranscriptSession = { projectId: null, sessionId: null };
const Context = createContext<TranscriptSession>(NONE);

export function TranscriptSessionProvider({
  projectId,
  sessionId,
  children,
}: TranscriptSession & { children: ReactNode }) {
  const value = useMemo(() => ({ projectId, sessionId }), [projectId, sessionId]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTranscriptSession(): TranscriptSession {
  return useContext(Context);
}
