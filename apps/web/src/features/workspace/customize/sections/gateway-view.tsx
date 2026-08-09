'use client';

/**
 * LLM — one Customize section that consolidates the per-project gateway surfaces
 * (Providers, Overview, Logs, Budgets, API keys) behind a single tab bar, so the
 * whole section reads as one consistent surface (no competing tab styles).
 *
 * The tab bar is one row: the section tabs sit on the left, the project default
 * model picker on the right. There's no duplicate default-model control inside
 * Routing; this shared picker is the single project-default surface.
 *
 * The active tab is LOCAL state, so switching tabs never touches the main
 * Customize rail. Deep-links / `openCustomize('llm-providers')` set the
 * hosting panel's section, read here via `useSettingsNav()` (once, and
 * followed on change) to pick the initial tab — Providers is the default,
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
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { GatewayApiReference } from '@/features/workspace/customize/sections/view/gateway/gateway-api-reference';
import { GatewayBudgets } from '@/features/workspace/customize/sections/view/gateway/gateway-budgets';
import { GatewayKeys } from '@/features/workspace/customize/sections/view/gateway/gateway-keys';
import { GatewayLogs } from '@/features/workspace/customize/sections/view/gateway/gateway-logs';
import { GatewayOverview } from '@/features/workspace/customize/sections/view/gateway/gateway-overview';
import { GatewayPlayground } from '@/features/workspace/customize/sections/view/gateway/gateway-playground';
import { GatewayRouting } from '@/features/workspace/customize/sections/view/gateway/gateway-routing';
import { useModelDefaults } from '@kortix/sdk/react';
import { useGatewayKeys } from '@/hooks/projects/use-project-gateway';
import { useSettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { gatewayRoutingPolicyKey, useProjectModels } from '@kortix/sdk/react';
import { useIsMutating } from '@tanstack/react-query';
import type { ActiveTab } from '@/features/workspace/customize/sections/llm-provider/types';

type LlmTab =
  | 'providers'
  | 'routing'
  | 'playground'
  | 'overview'
  | 'logs'
  | 'budgets'
  | 'keys'
  | 'api';

const LLM_TABS: { id: LlmTab; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'routing', label: 'Routing' },
  { id: 'playground', label: 'Playground' },
  { id: 'overview', label: 'Overview' },
  { id: 'logs', label: 'Logs' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'keys', label: 'API keys' },
  { id: 'api', label: 'API' },
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
  'llm-budgets': 'budgets',
  'llm-keys': 'keys',
  'llm-api': 'api',
};

export function LlmManagementView({ projectId }: { projectId: string }) {
  const { isOpen: open, activeTab: section, llmProvidersTab } = useSettingsNav();
  const [tab, setTab] = useState<LlmTab>(
    () => TAB_BY_SECTION[section as LegacyLlmSubTab] ?? 'providers',
  );

  // The project default is the single model authority for this project. Account
  // and platform defaults are display-only inheritance when no project value is
  // configured; choosing here always writes project scope.
  const models = useProjectModels(projectId);
  const modelDefaults = useModelDefaults(projectId);
  const routingMutationCount = useIsMutating({ mutationKey: gatewayRoutingPolicyKey(projectId) });
  // Only fetched once the API tab is open — this call needs the manage-keys
  // permission, and a read-only member should still see the reference (with
  // the prod-default base URL fallback) rather than eating a 403 on tab open.
  const gatewayKeysQuery = useGatewayKeys(projectId, tab === 'api');
  const gatewayUrl = gatewayKeysQuery.data?.gateway_url ?? null;
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
      <TabsContent value="providers" className="min-h-0 overflow-y-auto">
        <ProjectProviderModal
          asPanel
          projectId={projectId}
          open={open}
          onOpenChange={() => {}}
          defaultTab={llmProvidersTab as ActiveTab | undefined}
          canWrite={canWrite}
        />
      </TabsContent>
      <TabsContent value="overview" className="min-h-0 overflow-y-auto">
        <GatewayOverview projectId={projectId} />
      </TabsContent>
      <TabsContent value="routing" className="min-h-0 overflow-y-auto">
        <GatewayRouting
          projectId={projectId}
          canWrite={canWrite}
          projectDefaultPending={modelDefaults.isUpdating}
        />
      </TabsContent>
      <TabsContent value="playground" className="min-h-0 overflow-y-auto">
        <GatewayPlayground projectId={projectId} />
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 overflow-y-auto">
        <GatewayLogs projectId={projectId} />
      </TabsContent>
      <TabsContent value="budgets" className="min-h-0 overflow-y-auto">
        <GatewayBudgets projectId={projectId} canWrite={canWrite} />
      </TabsContent>
      <TabsContent value="keys" className="min-h-0 overflow-y-auto">
        <GatewayKeys
          projectId={projectId}
          canWrite={canWrite}
          onViewModels={() => setTab('providers')}
        />
      </TabsContent>
      <TabsContent value="api" className="min-h-0 overflow-y-auto">
        <div className="w-full space-y-4 p-5">
          <div className="space-y-1">
            <p className="text-foreground text-sm font-medium">Call the gateway</p>
            <p className="text-muted-foreground text-pretty text-xs">
              Drop-in OpenAI- and Anthropic-compatible endpoints for calling this project's gateway
              from outside a Kortix session.{' '}
              <button
                type="button"
                onClick={() => setTab('keys')}
                className="text-foreground cursor-pointer underline underline-offset-2"
              >
                Create a key
              </button>{' '}
              in API keys to try these with a real key.
            </p>
          </div>
          <GatewayApiReference
            apiKey="kortix_gw_..."
            gatewayUrl={gatewayUrl}
            onViewModels={() => setTab('providers')}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}
