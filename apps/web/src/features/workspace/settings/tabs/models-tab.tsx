'use client';

/**
 * The Models tab — the settings-panel home of the per-project LLM gateway.
 * `settings-panel.tsx:1129-1133` used to mount `LlmManagementView` directly on
 * `case 'models'`; this file gives it the container / pure-view shape every
 * other migrated tab has (`sandbox-tab.tsx`, `instructions-tab.tsx`, …).
 *
 * **The `llmGatewayEnabled` gate is preserved EXACTLY, not re-derived.** The
 * panel computes it once as `isLlmGatewayEnabled(project)`
 * (`settings-panel.tsx:659`) and threads it down; this tab renders `null` while
 * it is false, mirroring the legacy panel's
 * `if (section.startsWith('llm-') && !llmGatewayEnabled) return null;` — nothing
 * (not the placeholder), same as before. It is a DIFFERENT flag from
 * `llmGatewayAvailable`, which gates the rail row only; do not substitute one
 * for the other.
 *
 * **The `llm-*` sub-sections are unchanged.** `LlmManagementView`
 * (`gateway-view.tsx`) still owns the whole sub-tab bar — Providers, Models,
 * Routing, Playground, Overview, Logs, Budgets, API keys, API — and still reads
 * `useSettingsNav()` to follow a deep link into one of them. The seven legacy
 * `llm-*` URL ids continue to resolve through `settings-tabs.ts`'s
 * `RENAMED_TABS` (all seven fold to `models`), which this file does not touch.
 *
 * **What DID change inside it (JAY-510):** the Providers sub-tab now mounts
 * `features/providers/provider-connect.tsx` directly instead of
 * `ProjectProviderModal asPanel`, so connecting a provider from this tab opens
 * no dialog, needs no accordion and passes no search field; and the provider
 * modal's old nested "Models" tab was flattened up to a sibling sub-tab so that
 * capability keeps a home.
 *
 * `LlmManagementView` is a SLOT, not rendered inline: it owns
 * `useProjectModels`/`useModelDefaults`/`useIsMutating`/`useSettingsNav` and
 * cannot render under `renderToStaticMarkup` with no provider tree — same
 * reasoning as `instructions-tab.tsx`'s `commandsSlot`.
 *
 * `ModelsTab` is the container: it only exists once this tab is active, which
 * `SettingsTabPane` guarantees (`if (!active) return null;`), so nothing here
 * fetches on panel open.
 */

import type { ReactNode } from 'react';

import { LlmManagementView } from '@/features/workspace/customize/sections/gateway-view';

export interface ModelsTabViewProps {
  /** `LlmManagementView`, built by the container — see the header comment for
   *  why it's a slot. `undefined` (nothing rendered) lets this view render
   *  under `renderToStaticMarkup` with no providers. */
  gatewaySlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching. */
export function ModelsTabView({ gatewaySlot }: ModelsTabViewProps) {
  return <>{gatewaySlot}</>;
}

/** Container. Renders nothing at all while the gateway is disabled. */
export function ModelsTab({
  projectId,
  llmGatewayEnabled,
}: {
  projectId: string;
  llmGatewayEnabled: boolean;
}) {
  if (!llmGatewayEnabled) return null;
  return <ModelsTabView gatewaySlot={<LlmManagementView projectId={projectId} />} />;
}
