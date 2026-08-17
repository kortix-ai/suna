'use client';

/**
 * LLM — one Customize section that consolidates the per-project gateway
 * surfaces behind a single tab bar, so the whole section reads as one
 * consistent surface (no competing tab styles).
 *
 * ## Six tabs, down from ten
 *
 * The bar carried ten, three of which should never have been tabs:
 *
 *  - **Playground is gone.** A prompt box that fanned one message across
 *    models. Every project already has a real session for that, one click
 *    away, with the full runtime behind it. Deleted, not hidden —
 *    `gateway-playground.tsx` and its test are removed. The API route it
 *    called (`POST /gateway/playground`) still exists and is untouched; this
 *    is a UI removal.
 *  - **`keys` and `api` folded into `providers`.** Two tabs both labelled
 *    "API keys" sat four apart, and the reference for calling the gateway sat
 *    next to neither of them. All three are sections of one tab now — see
 *    `llm-api-keys-tab.tsx` for the direction-of-travel argument.
 *  - **`budgets` folded into `overview`.** The cap belongs under the number
 *    it caps — see `gateway-budgets.tsx`.
 *
 * Order follows the work: get a key, choose models, add your own provider,
 * shape the routing, then watch what it costs and what it did. API keys is
 * first because nothing else on this screen functions without one; Overview
 * is no longer first because a dashboard is where you arrive second.
 *
 * The tab bar is one row: the section tabs sit on the left, the project default
 * model picker on the right. There's no duplicate default-model control inside
 * Routing; this shared picker is the single project-default surface.
 *
 * The active tab is LOCAL state, so switching tabs never touches the main
 * Customize rail. Deep-links / `openCustomize('llm-providers')` set the
 * hosting panel's section, read here via `useSettingsNav()` (once, and
 * followed on change) to pick the initial tab — API keys is the default,
 * core surface.
 *
 * This view reads `useSettingsNav()`, never a store directly, so it mounts
 * under either the legacy Customize panel or the new Settings panel — see
 * `features/workspace/shared/settings-nav-context.tsx`.
 */

import { useEffect, useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import { LlmApiKeysTab } from '@/features/workspace/customize/sections/llm-api-keys-tab';
import { CustomProviderPanel } from '@/features/workspace/customize/sections/llm-provider/custom-provider-panel';
import { ModelsTab } from '@/features/workspace/customize/sections/llm-provider/models-tab';
import { GatewayLogs } from '@/features/workspace/customize/sections/view/gateway/gateway-logs';
import { GatewayOverview } from '@/features/workspace/customize/sections/view/gateway/gateway-overview';
import { GatewayRouting } from '@/features/workspace/customize/sections/view/gateway/gateway-routing';
import { useSettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { gatewayRoutingPolicyKey, useModelDefaults, useProjectModels } from '@kortix/sdk/react';
import { useIsMutating } from '@tanstack/react-query';

type LlmTab = 'providers' | 'models' | 'custom' | 'routing' | 'overview' | 'logs';

const LLM_TABS: { id: LlmTab; label: string }[] = [
  // Provider keys + gateway keys + the reference for calling the gateway.
  // Three tabs before, two of them sharing a label — see `llm-api-keys-tab.tsx`.
  { id: 'providers', label: 'API keys' },
  { id: 'models', label: 'Models' },
  // The custom-provider form used to be section 4 of the Providers tab. It
  // moved to its own tab so the screen everyone uses to paste a key stops
  // ending in a form almost nobody fills — see `custom-provider-panel.tsx`.
  { id: 'custom', label: 'Custom' },
  { id: 'routing', label: 'Routing' },
  // Stats AND the spend cap — the former Budgets tab is a section of this one.
  // Label is "Costs" — the id stays `overview` so the `llm-overview` /
  // `llm-budgets` legacy deep-link re-points (settings-tabs.ts) and this
  // file's own render switch keep working unchanged.
  { id: 'overview', label: 'Costs' },
  { id: 'logs', label: 'Logs' },
];

/**
 * The legacy Customize overlay's `llm-*` `CustomizeSection` ids. The new
 * Settings overlay's `SettingsTab` union has no equivalent — every one of
 * these collapses into the single `models` tab at the redirect
 * (`settings-tabs.ts`'s `RENAMED_TABS`), so `activeTab` is never one of them
 * while mounted there; this map only fires while mounted under the legacy
 * panel (deleted once the cutover is complete) or for a raw deep-link value
 * that slips through before a redirect resolves. Kept local (not imported
 * from the legacy Customize-sections module, which no longer exists) since nothing
 * else needs this exact 7-member set.
 */
type LegacyLlmSubTab =
  | 'llm-management'
  | 'llm-overview'
  | 'llm-providers'
  | 'llm-logs'
  | 'llm-budgets'
  | 'llm-keys'
  | 'llm-api';

const TAB_BY_SECTION: Partial<Record<LegacyLlmSubTab, LlmTab>> = {
  'llm-management': 'providers',
  'llm-providers': 'providers',
  'llm-overview': 'overview',
  'llm-logs': 'logs',
  // Budgets is a section of Overview now; keys and the API reference are
  // sections of the API-keys tab. The legacy ids still resolve — they land on
  // the tab that absorbed them rather than 404ing into the default.
  'llm-budgets': 'overview',
  'llm-keys': 'providers',
  'llm-api': 'providers',
};

export function LlmManagementView({ projectId }: { projectId: string }) {
  const { isOpen: open, activeTab: section } = useSettingsNav();
  const [tab, setTab] = useState<LlmTab>(
    () => TAB_BY_SECTION[section as LegacyLlmSubTab] ?? 'providers',
  );

  // The project default is the single model authority for this project. Account
  // and platform defaults are display-only inheritance when no project value is
  // configured; choosing here always writes project scope.
  const models = useProjectModels(projectId);
  const modelDefaults = useModelDefaults(projectId);
  const routingMutationCount = useIsMutating({ mutationKey: gatewayRoutingPolicyKey(projectId) });
  const effectiveDefault =
    modelDefaults.projectDefault ??
    modelDefaults.accountDefault ??
    (modelDefaults.freeTier ? undefined : modelDefaults.platformDefault) ??
    null;
  // A role with the LLM section's READ leaf (project.read) but not project.write
  // sees the gateway read-only: logs/overview/spend stay visible, but the
  // project-default model picker — the one mutating control in this bar — is
  // hidden so a read-only user cannot trigger a forbidden write.
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;

  // Follow an external deep-link (e.g. openCustomize('llm-providers')) to its
  // tab. Plain in-view tab clicks stay local and never move the main rail.
  useEffect(() => {
    const next = TAB_BY_SECTION[section as LegacyLlmSubTab];
    if (next) setTab(next);
  }, [section]);

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as LlmTab)}
      className="bg-background flex h-full min-h-0 flex-col gap-0"
    >
      {/* One bar: section tabs left, default-model picker right. The underline
          list sits flush on the container's divider (no vertical padding so the
          active underline lands exactly on the border). */}
      <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-5 pt-2">
        <TabsList type="underline" size="lg" className="border-b-0">
          {LLM_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="w-fit flex-none text-xs">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {canWrite ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-muted-foreground hidden text-xs sm:inline">Project default</span>
            <ModelSelector
              models={models}
              selectedModel={effectiveDefault}
              unsetLabel="Project default"
              disabled={
                modelDefaults.isLoading || modelDefaults.isUpdating || routingMutationCount > 0
              }
              onSelect={(m) => {
                if (!m) return;
                void modelDefaults
                  .setProjectDefault(m)
                  .catch(() => errorToast('Could not update the project default'));
              }}
            />
          </div>
        ) : null}
      </div>

      {/* min-h-0 lets each panel actually shrink inside the flex column so
          overflow-y-auto scrolls instead of clipping tall content. */}
      {/* JAY-510: the settings-panel path mounts `ProviderConnect` DIRECTLY —
          no Modal, no dialog, so connecting Anthropic here opens nothing. The
          modal shell (`ProjectProviderModal`) is only for the model selector
          and the Secrets tab, which are dialogs by construction. It is now
          section 1 of `LlmApiKeysTab`, which mounts it the same way. */}
      <TabsContent value="providers" className="min-h-0 overflow-y-auto">
        <LlmApiKeysTab
          projectId={projectId}
          canWrite={canWrite}
          enabled={open}
          onViewModels={() => setTab('models')}
        />
      </TabsContent>
      {/* The model-visibility list used to sit one level deeper, inside the
          provider modal's own "Models" tab. Flattened to a sibling here so it
          keeps a home now that `ProviderConnect` has no tabs of its own. */}
      <TabsContent value="models" className="min-h-0 overflow-y-auto">
        <ModelsTab projectId={projectId} />
      </TabsContent>
      <TabsContent value="custom" className="min-h-0 overflow-y-auto">
        <CustomProviderPanel projectId={projectId} canWrite={canWrite} />
      </TabsContent>
      {/* Stats + the spend cap. `canWrite` reaches the budget controls that
          used to live one tab over. */}
      <TabsContent value="overview" className="min-h-0 overflow-y-auto">
        <GatewayOverview projectId={projectId} canWrite={canWrite} />
      </TabsContent>
      <TabsContent value="routing" className="min-h-0 overflow-y-auto">
        <GatewayRouting
          projectId={projectId}
          canWrite={canWrite}
          projectDefaultPending={modelDefaults.isUpdating}
        />
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 overflow-y-auto">
        <GatewayLogs projectId={projectId} />
      </TabsContent>
    </Tabs>
  );
}
