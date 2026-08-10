'use client';

/**
 * LLM — one Customize section that consolidates the per-workspace gateway surfaces
 * (Providers, Overview, Logs, Budgets, API keys) behind a single tab bar, so the
 * whole section reads as one consistent surface (no competing tab styles).
 *
 * The tab bar is one row: the section tabs sit on the left, the workspace default
 * model picker on the right. There's no duplicate default-model control inside
 * Routing; this shared picker is the single workspace-default surface.
 *
 * The active tab is LOCAL state, so switching tabs never touches the main
 * Customize rail. Deep-links / `openCustomize('llm-providers')` set the store
 * section, which we read once (and follow on change) to pick the initial tab —
 * Providers is the default, core surface.
 */

import { useEffect, useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import { WorkspaceProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { GatewayApiReference } from '@/features/workspace/customize/sections/view/gateway/gateway-api-reference';
import { GatewayBudgets } from '@/features/workspace/customize/sections/view/gateway/gateway-budgets';
import { GatewayKeys } from '@/features/workspace/customize/sections/view/gateway/gateway-keys';
import { GatewayLogs } from '@/features/workspace/customize/sections/view/gateway/gateway-logs';
import { GatewayOverview } from '@/features/workspace/customize/sections/view/gateway/gateway-overview';
import { GatewayPlayground } from '@/features/workspace/customize/sections/view/gateway/gateway-playground';
import { GatewayRouting } from '@/features/workspace/customize/sections/view/gateway/gateway-routing';
import { useModelDefaults } from '@kortix/sdk/react';
import { useGatewayKeys } from '@/hooks/workspaces/use-workspace-gateway';
import type { CustomizeSection } from '@/lib/customize-sections';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import { useCustomizeStore } from '@/stores/customize-store';
import { gatewayRoutingPolicyKey, useWorkspaceModels } from '@kortix/sdk/react';
import { useIsMutating } from '@tanstack/react-query';

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

const TAB_BY_SECTION: Partial<Record<CustomizeSection, LlmTab>> = {
  'llm-management': 'providers',
  'llm-providers': 'providers',
  'llm-overview': 'overview',
  'llm-logs': 'logs',
  'llm-budgets': 'budgets',
  'llm-keys': 'keys',
  'llm-api': 'api',
};

export function LlmManagementView({ workspaceId }: { workspaceId: string }) {
  const open = useCustomizeStore((s) => s.open);
  const section = useCustomizeStore((s) => s.section);
  const llmProvidersTab = useCustomizeStore((s) => s.llmProvidersTab);
  const [tab, setTab] = useState<LlmTab>(() => TAB_BY_SECTION[section] ?? 'providers');

  // The workspace default is the single model authority for this workspace. Account
  // and platform defaults are display-only inheritance when no workspace value is
  // configured; choosing here always writes workspace scope.
  const models = useWorkspaceModels(workspaceId);
  const modelDefaults = useModelDefaults(workspaceId);
  const routingMutationCount = useIsMutating({ mutationKey: gatewayRoutingPolicyKey(workspaceId) });
  // Only fetched once the API tab is open — this call needs the manage-keys
  // permission, and a read-only member should still see the reference (with
  // the prod-default base URL fallback) rather than eating a 403 on tab open.
  const gatewayKeysQuery = useGatewayKeys(workspaceId, tab === 'api');
  const gatewayUrl = gatewayKeysQuery.data?.gateway_url ?? null;
  const effectiveDefault =
    modelDefaults.workspaceDefault ??
    modelDefaults.accountDefault ??
    (modelDefaults.freeTier ? undefined : modelDefaults.platformDefault) ??
    null;
  // A role with the LLM section's READ leaf (workspace.read) but not workspace.write
  // sees the gateway read-only: logs/overview/spend stay visible, but the
  // workspace-default model picker — the one mutating control in this bar — is
  // hidden so a read-only user cannot trigger a forbidden write.
  const canWrite =
    useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE).allowed === true;

  // Follow an external deep-link (e.g. openCustomize('llm-providers')) to its
  // tab. Plain in-view tab clicks stay local and never move the main rail.
  useEffect(() => {
    const next = TAB_BY_SECTION[section];
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
            <span className="text-muted-foreground hidden text-xs sm:inline">Workspace default</span>
            <ModelSelector
              models={models}
              selectedModel={effectiveDefault}
              unsetLabel="Workspace default"
              disabled={
                modelDefaults.isLoading || modelDefaults.isUpdating || routingMutationCount > 0
              }
              onSelect={(m) => {
                if (!m) return;
                void modelDefaults
                  .setWorkspaceDefault(m)
                  .catch(() => errorToast('Could not update the workspace default'));
              }}
            />
          </div>
        ) : null}
      </div>

      {/* min-h-0 lets each panel actually shrink inside the flex column so
          overflow-y-auto scrolls instead of clipping tall content. */}
      <TabsContent value="providers" className="min-h-0 overflow-y-auto">
        <WorkspaceProviderModal
          asPanel
          workspaceId={workspaceId}
          open={open}
          onOpenChange={() => {}}
          defaultTab={llmProvidersTab}
          canWrite={canWrite}
        />
      </TabsContent>
      <TabsContent value="overview" className="min-h-0 overflow-y-auto">
        <GatewayOverview workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="routing" className="min-h-0 overflow-y-auto">
        <GatewayRouting
          workspaceId={workspaceId}
          canWrite={canWrite}
          workspaceDefaultPending={modelDefaults.isUpdating}
        />
      </TabsContent>
      <TabsContent value="playground" className="min-h-0 overflow-y-auto">
        <GatewayPlayground workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 overflow-y-auto">
        <GatewayLogs workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="budgets" className="min-h-0 overflow-y-auto">
        <GatewayBudgets workspaceId={workspaceId} canWrite={canWrite} />
      </TabsContent>
      <TabsContent value="keys" className="min-h-0 overflow-y-auto">
        <GatewayKeys
          workspaceId={workspaceId}
          canWrite={canWrite}
          onViewModels={() => setTab('providers')}
        />
      </TabsContent>
      <TabsContent value="api" className="min-h-0 overflow-y-auto">
        <div className="w-full space-y-4 p-5">
          <div className="space-y-1">
            <p className="text-foreground text-sm font-medium">Call the gateway</p>
            <p className="text-muted-foreground text-pretty text-xs">
              Drop-in OpenAI- and Anthropic-compatible endpoints for calling this workspace's gateway
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
