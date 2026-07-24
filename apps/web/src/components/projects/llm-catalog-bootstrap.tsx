'use client';

import { useLiveLlmProviderCatalog } from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';

/**
 * Renders nothing — fires the live provider-catalog fetch
 * (`GET /projects/:id/llm-catalog/providers`) once per project, as early as
 * possible (mounted at the project layout, alongside SessionCacheWarmer).
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
  useLiveLlmProviderCatalog(projectId, true);
  return null;
}
