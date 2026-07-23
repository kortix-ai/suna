'use client';

import { useEffect, useRef } from 'react';
import { useSessionBrowserStore } from '@/stores/session-browser-store';

/** A consumer mounted by the click itself (mobile drawer, Easy detail)
 *  observes the request within this window; anything older is a leftover
 *  from a session the panel never got to consume. */
const FRESH_REQUEST_WINDOW_MS = 2_000;

/**
 * Easy mode's consumer for chat file-open requests (`fileOpenBySession`) —
 * clicks on file paths and markdown file links in the transcript. Advanced
 * mode consumes the same channel through `SessionFilesExplorer`, which Easy
 * never mounts; without this the request opened the panel and nothing else.
 *
 * Every request this hook observes is consumed (removed from the store) on
 * delivery, so a remount can never re-observe a request that was already
 * delivered — closing and reopening the mobile drawer within the freshness
 * window no longer replays the file it already opened. The freshness window
 * only matters for a request that PREDATES this consumer's mount: fresh
 * enough to be the very click that caused the mount (mobile drawer opening),
 * it fires; older than that, it's a leftover from a consumer that never
 * mounted, and is discarded silently (still consumed, never fired).
 *
 * The seen-ref exists only to dedupe React StrictMode's double-invoked
 * effect, which re-runs with the same captured `request` after the first
 * invocation has already deleted it from the store.
 */
export function useChatFileOpenRequest(
  sessionId: string,
  onOpen: (path: string, line?: number) => void,
) {
  const request = useSessionBrowserStore((s) => s.fileOpenBySession[sessionId]);
  const seen = useRef<{ sessionId: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!request) return;
    const firstObservation = seen.current?.sessionId !== sessionId;
    if (!firstObservation && request.nonce <= seen.current!.nonce) return;
    seen.current = { sessionId, nonce: request.nonce };
    useSessionBrowserStore.getState().consumeFileOpen(sessionId, request.nonce);
    if (firstObservation && Date.now() - request.requestedAt >= FRESH_REQUEST_WINDOW_MS) return;
    onOpen(request.path, request.line);
  }, [sessionId, request, onOpen]);
}
