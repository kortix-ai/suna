'use client';

/**
 * Models — one Customize section that consolidates every per-project gateway
 * surface (Models, Overview, Activity, Limits, Routing, Playground, API
 * access) behind three top-level tabs, so the whole section reads as one
 * consistent surface for a non-technical audience instead of eight competing
 * tab labels.
 *
 * The tab bar is a single row of section tabs — the project default-model
 * picker used to share this row (Task 16) but Task 17 relocated it into the
 * Models tab's own "Default model" section (see `models-view.tsx`), so
 * "you're set" reassurance and the one control that actually sets it live in
 * the same place. There's still no duplicate default-model control inside
 * Routing.
 *
 * Usage and Developer each carry a compact sub-tab row for their grouped
 * surfaces, with LOCAL sub-tab state — same as the top-level tab, switching
 * never touches the main Customize rail. Deep-links /
 * `openCustomize('llm-…')` set the store section, which we read once (and
 * follow on change) to pick the initial tab (and sub-tab) — Models is the
 * default, core surface.
 */

import { useIsMutating } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ModelsView } from '@/features/workspace/customize/sections/llm-provider/models-view';
import { GatewayApiAccess } from '@/features/workspace/customize/sections/view/gateway/gateway-api-access';
import { GatewayBudgets } from '@/features/workspace/customize/sections/view/gateway/gateway-budgets';
import { GatewayLogs } from '@/features/workspace/customize/sections/view/gateway/gateway-logs';
import { GatewayOverview } from '@/features/workspace/customize/sections/view/gateway/gateway-overview';
import { GatewayPlayground } from '@/features/workspace/customize/sections/view/gateway/gateway-playground';
import { GatewayRouting } from '@/features/workspace/customize/sections/view/gateway/gateway-routing';
import { useGatewayKeys } from '@/hooks/projects/use-project-gateway';
import { modelDefaultsKey } from '@/hooks/runtime/use-model-defaults';
import type { CustomizeSection } from '@/lib/customize-sections';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useCustomizeStore } from '@/stores/customize-store';

type LlmTab = 'models' | 'usage' | 'developer';
type UsageSubTab = 'overview' | 'activity' | 'limits';
type DeveloperSubTab = 'routing' | 'playground' | 'api';

const LLM_TABS: { id: LlmTab; label: string }[] = [
  { id: 'models', label: 'Models' },
  { id: 'usage', label: 'Usage' },
  { id: 'developer', label: 'Developer' },
];

const USAGE_SUB_TABS: { id: UsageSubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'limits', label: 'Limits' },
];

const DEVELOPER_SUB_TABS: { id: DeveloperSubTab; label: string }[] = [
  { id: 'routing', label: 'Routing' },
  { id: 'playground', label: 'Playground' },
  { id: 'api', label: 'API access' },
];

const TAB_BY_SECTION: Partial<Record<CustomizeSection, LlmTab>> = {
  'llm-management': 'models',
  'llm-providers': 'models',
  'llm-overview': 'usage',
  'llm-logs': 'usage',
  'llm-budgets': 'usage',
  'llm-keys': 'developer',
  'llm-api': 'developer',
};

const USAGE_SUB_TAB_BY_SECTION: Partial<Record<CustomizeSection, UsageSubTab>> = {
  'llm-overview': 'overview',
  'llm-logs': 'activity',
  'llm-budgets': 'limits',
};

const DEVELOPER_SUB_TAB_BY_SECTION: Partial<Record<CustomizeSection, DeveloperSubTab>> = {
  'llm-keys': 'api',
  'llm-api': 'api',
};

export function LlmManagementView({ projectId }: { projectId: string }) {
  const section = useCustomizeStore((s) => s.section);
  const [tab, setTab] = useState<LlmTab>(() => TAB_BY_SECTION[section] ?? 'models');
  const [usageTab, setUsageTab] = useState<UsageSubTab>(
    () => USAGE_SUB_TAB_BY_SECTION[section] ?? 'overview',
  );
  const [developerTab, setDeveloperTab] = useState<DeveloperSubTab>(
    () => DEVELOPER_SUB_TAB_BY_SECTION[section] ?? 'routing',
  );

  // The project default is the single model authority for this project. Account
  // and platform defaults are display-only inheritance when no project value is
  // configured; choosing here always writes project scope. The picker itself
  // now lives in the Models tab (`models-view.tsx`'s "Default model" section,
  // Task 17), which owns the only `useModelDefaults` mutation instance — this
  // view no longer mounts that hook at all. `useMutation().isPending` is
  // per-hook-instance, so reading it from a second `useModelDefaults(projectId)`
  // call here would always read this component's own (never-fired) mutation,
  // not the Models tab's. `useIsMutating` with the hook's shared
  // `modelDefaultsKey` mutation key observes any in-flight write regardless of
  // which component's instance issued it, so Routing below still can't race a
  // pending project-default write.
  const projectDefaultPending = useIsMutating({ mutationKey: modelDefaultsKey(projectId) }) > 0;
  // Only fetched once the API access sub-tab is open — this call needs the
  // manage-keys permission, and a read-only member should still see the
  // reference (with the prod-default base URL fallback) rather than eating a
  // 403 on tab open.
  const gatewayKeysQuery = useGatewayKeys(projectId, tab === 'developer' && developerTab === 'api');
  const gatewayUrl = gatewayKeysQuery.data?.gateway_url ?? null;
  // A role with the LLM section's READ leaf (project.read) but not project.write
  // sees the gateway read-only: logs/overview/spend stay visible, and the
  // Models tab's default-model picker hides itself so a read-only user cannot
  // trigger a forbidden write.
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;

  // Follow an external deep-link (e.g. openCustomize('llm-providers')) to its
  // tab (and sub-tab, where applicable). Plain in-view tab clicks stay local
  // and never move the main rail.
  useEffect(() => {
    const next = TAB_BY_SECTION[section];
    if (next) setTab(next);
    const nextUsage = USAGE_SUB_TAB_BY_SECTION[section];
    if (nextUsage) setUsageTab(nextUsage);
    const nextDeveloper = DEVELOPER_SUB_TAB_BY_SECTION[section];
    if (nextDeveloper) setDeveloperTab(nextDeveloper);
  }, [section]);

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as LlmTab)}
      className="bg-background flex h-full min-h-0 flex-col gap-0"
    >
      {/* The underline list sits flush on the container's divider (no vertical
          padding so the active underline lands exactly on the border). The
          default-model picker that used to share this row moved into the
          Models tab (Task 17). */}
      <div className="border-border flex shrink-0 items-center border-b px-5 pt-2">
        <TabsList type="underline" size="lg" className="border-b-0">
          {LLM_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="w-fit flex-none text-xs">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {/* min-h-0 lets each panel actually shrink inside the flex column so
          overflow-y-auto scrolls instead of clipping tall content. */}
      <TabsContent value="models" className="min-h-0 overflow-y-auto">
        <ModelsView projectId={projectId} canWrite={canWrite} />
      </TabsContent>

      <TabsContent value="usage" className="flex min-h-0 flex-col overflow-hidden">
        <Tabs
          value={usageTab}
          onValueChange={(v) => setUsageTab(v as UsageSubTab)}
          className="flex h-full min-h-0 flex-col gap-0"
        >
          <div className="border-border shrink-0 border-b px-4 py-2">
            <TabsList type="secondary">
              {USAGE_SUB_TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto">
            <GatewayOverview projectId={projectId} />
          </TabsContent>
          <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
            <GatewayLogs projectId={projectId} />
          </TabsContent>
          <TabsContent value="limits" className="min-h-0 flex-1 overflow-y-auto">
            <GatewayBudgets projectId={projectId} canWrite={canWrite} />
          </TabsContent>
        </Tabs>
      </TabsContent>

      <TabsContent value="developer" className="flex min-h-0 flex-col overflow-hidden">
        <Tabs
          value={developerTab}
          onValueChange={(v) => setDeveloperTab(v as DeveloperSubTab)}
          className="flex h-full min-h-0 flex-col gap-0"
        >
          <div className="border-border shrink-0 border-b px-4 py-2">
            <TabsList type="secondary">
              {DEVELOPER_SUB_TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="routing" className="min-h-0 flex-1 overflow-y-auto">
            <GatewayRouting
              projectId={projectId}
              canWrite={canWrite}
              projectDefaultPending={projectDefaultPending}
            />
          </TabsContent>
          <TabsContent value="playground" className="min-h-0 flex-1 overflow-y-auto">
            <GatewayPlayground projectId={projectId} />
          </TabsContent>
          <TabsContent value="api" className="min-h-0 flex-1 overflow-y-auto">
            <GatewayApiAccess projectId={projectId} canWrite={canWrite} gatewayUrl={gatewayUrl} />
          </TabsContent>
        </Tabs>
      </TabsContent>
    </Tabs>
  );
}
