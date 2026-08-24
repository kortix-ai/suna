'use client';

import { useEffect, useState } from 'react';

import { useLiveLlmProviderCatalog } from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';

/**
 * Renders nothing — fires the live provider-catalog fetch
 * (`GET /projects/:id/llm-catalog/providers`) once per project, as early as
 * possible from the project layout.
 *
 * Why here and not just inside the provider connect modal: `LLM_PROVIDERS`
 * (apps/web/src/lib/llm-providers.ts) is read by more than the modal —
 * model-selector.tsx, the session model gate, provider branding — and ES
 * module bindings are live, so ANY of those consumers sees the fresh data
 * the moment this fetch resolves, without importing this component
 * themselves. Mounting only inside the modal would mean a user who never
 * opens "Customize > LLM Provider" in a given project never gets live data
 * for the whole session — this way the fetch is already in flight (or
 * resolved, staleTime 1h) before anything downstream needs it.
 */
export function LlmCatalogBootstrap({ projectId }: { projectId: string }) {
  // AFTER the page is idle, never in the session-open critical path.
  //
  // This fetch was the single largest request on a session open — 4 MB,
  // 55 % of everything the page transferred, 8 s (essentia, 2026-08-24) —
  // for data nothing on that screen renders. It exists so the connect modal
  // and provider branding are warm by the time someone opens Customize; that
  // is a background concern, and it now yields to everything the reader is
  // actually waiting for (start, transcript, permissions).
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(() => setIdle(true), { timeout: 10_000 });
      return () => win.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setIdle(true), 3_000);
    return () => clearTimeout(t);
  }, []);
  useLiveLlmProviderCatalog(projectId, idle);
  return null;
}
