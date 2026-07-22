'use client';

import { useEffect, useRef } from 'react';
import { useSessionBrowserStore } from '@/stores/session-browser-store';

/** A consumer mounted by the click itself (mobile drawer, Easy detail)
 *  observes the request within this window; anything older is a leftover
 *  from a session the panel never got to consume. */
const FRESH_REQUEST_WINDOW_MS = 2_000;

/**
 * Easy mode's consumer for chat port-open requests (`appOpenBySession`) —
 * clicks on the localhost chips and preview cards `SandboxUrlDetector` appends
 * to assistant messages. The exact twin of {@link useChatFileOpenRequest},
 * down to the one-shot consume, the freshness window, and the StrictMode
 * seen-ref; see that hook for why each piece is there.
 *
 * Advanced mode has no consumer here and needs none: it hosts the port in
 * `BrowserPanel`, which `openPortInSessionPanel` drives through tab metadata
 * instead.
 */
export function useChatAppOpenRequest(
  sessionId: string,
  onOpen: (url: string, name?: string) => void,
) {
  const request = useSessionBrowserStore((s) => s.appOpenBySession[sessionId]);
  const seen = useRef<{ sessionId: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!request) return;
    const firstObservation = seen.current?.sessionId !== sessionId;
    if (!firstObservation && request.nonce <= seen.current!.nonce) return;
    seen.current = { sessionId, nonce: request.nonce };
    useSessionBrowserStore.getState().consumeAppOpen(sessionId, request.nonce);
    if (firstObservation && Date.now() - request.requestedAt >= FRESH_REQUEST_WINDOW_MS) return;
    onOpen(request.url, request.name);
  }, [sessionId, request, onOpen]);
}
