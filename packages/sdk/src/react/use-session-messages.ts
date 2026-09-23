'use client';

import { useMemo } from 'react';

import { useSyncStore, type MessageWithParts } from '../browser/stores/sync-store';
import { messagesBeforeRewind } from '../core/session/rewind';
import { selectSessionRows, useReadableSessionId } from './session-transcript-subscription';

/** The identity `useSessionMessages` needs from a `useSession` result. */
export interface SessionMessagesSource {
  projectId: string;
  sessionId: string;
  /** Canonical OpenCode root id, or null while resolving. */
  opencodeSessionId: string | null;
}

const EMPTY_ROWS: MessageWithParts[] = [];

/**
 * The live transcript of a session a `useSession` hook owns — the same rows,
 * with the same staged-rewind boundary, as `useSession().messages`.
 *
 * Use it with `useSession(…, { subscribeMessages: false })`: the lifecycle
 * host then stops re-rendering on every streamed delta, and only the component
 * that calls this hook (the transcript) does. Row objects keep their identity
 * while their message is unchanged, so a memoized row component re-renders
 * only for the message that is streaming.
 *
 * Read-only: it starts no request. The owning `useSession` still runs the
 * sync engine (fetch, stream, pollers).
 */
export function useSessionMessages(session: SessionMessagesSource): MessageWithParts[] {
  const ocSessionId = session.opencodeSessionId ?? '';
  const readableSessionId = useReadableSessionId(
    ocSessionId,
    `${session.projectId}/${session.sessionId}`,
  );
  const rows = useSyncStore((state) =>
    readableSessionId ? selectSessionRows(state, readableSessionId) : EMPTY_ROWS,
  );
  const rewind = useSyncStore((state) => state.sessionRevert[ocSessionId] ?? null);
  return useMemo(() => messagesBeforeRewind(rows, rewind), [rows, rewind]);
}
