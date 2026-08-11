'use client';

/**
 * The Models tab — the settings-panel home of the per-project LLM gateway.
 * `settings-panel.tsx:1129-1133` used to mount `LlmManagementView` directly on
 * `case 'models'`; this file gives it the container / pure-view shape every
 * other migrated tab has (`sandbox-tab.tsx`, `experimental-tab.tsx`, …).
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
 * reasoning as `sandbox-tab.tsx`'s `templatesSlot`.
 *
 * **The pane heading sits above the gateway's own sub-tab bar.**
 * `LlmManagementView` fills its tab with its OWN full-height `Tabs` shell
 * (Providers/Models/Routing/Playground/…, each an internally-scrolling
 * `TabsContent`) and declares no width of its own — see `DELEGATING_TABS` in
 * `tab-content-width.test.ts`. `ModelsTabView` renders `SettingsTabHeader` as
 * a shrink-0 strip above that shell, in a `flex h-full min-h-0 flex-col`
 * column, with `gatewaySlot` given `min-h-0 flex-1` so the gateway's own sub-
 * tab bar and per-section scrolling are unchanged — same split
 * `sandbox-tab.tsx` uses for its templates slot.
 *
 * `ModelsTab` is the container: it only exists once this tab is active, which
 * `SettingsTabPane` guarantees (`if (!active) return null;`), so nothing here
 * fetches on panel open.
 */

import type { ReactNode } from 'react';

import { LlmManagementView } from '@/features/workspace/customize/sections/gateway-view';
import { SettingsTabHeader } from '../settings-tab-header';

export interface ModelsTabViewProps {
  /** `LlmManagementView`, built by the container — see the header comment for
   *  why it's a slot. `undefined` (nothing rendered) lets this view render
   *  under `renderToStaticMarkup` with no providers. */
  gatewaySlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching. */
export function ModelsTabView({ gatewaySlot }: ModelsTabViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pt-8">
        <SettingsTabHeader tab="models" />
      </div>
      <div className="min-h-0 flex-1">{gatewaySlot}</div>
    </div>
  );
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
