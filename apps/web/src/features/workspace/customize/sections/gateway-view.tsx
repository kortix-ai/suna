'use client';

/**
 * LLM — one Customize section that consolidates the per-project gateway surfaces
 * (Providers, Overview, Logs, Budgets, API keys) behind a single tab bar, so the
 * whole section reads as one consistent surface (no competing tab styles).
 *
 * The tab bar is one row: the section tabs sit on the left, the account default
 * model picker ("Choose model") on the right — `justify-between`. There's no
 * separate default-model header; the picker in the bar IS where you set "my
 * default", and the gateway resolves `auto` against it.
 *
 * The active tab is LOCAL state, so switching tabs never touches the main
 * Customize rail. Deep-links / `openCustomize('llm-providers')` set the store
 * section, which we read once (and follow on change) to pick the initial tab —
 * Providers is the default, core surface.
 */

import { useEffect, useMemo, useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ModelSelector } from '@/features/session/model-selector';
import { flattenModels } from '@/features/session/session-chat-input';
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { GatewayBudgets } from '@/features/workspace/customize/sections/view/gateway/gateway-budgets';
import { GatewayKeys } from '@/features/workspace/customize/sections/view/gateway/gateway-keys';
import { GatewayLogs } from '@/features/workspace/customize/sections/view/gateway/gateway-logs';
import { GatewayOverview } from '@/features/workspace/customize/sections/view/gateway/gateway-overview';
import { useModelDefaults } from '@/hooks/opencode/use-model-defaults';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import type { CustomizeSection } from '@/lib/customize-sections';
import { useCustomizeStore } from '@/stores/customize-store';

type LlmTab = 'providers' | 'overview' | 'logs' | 'budgets' | 'keys';

const LLM_TABS: { id: LlmTab; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'overview', label: 'Overview' },
  { id: 'logs', label: 'Logs' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'keys', label: 'API keys' },
];

const TAB_BY_SECTION: Partial<Record<CustomizeSection, LlmTab>> = {
  'llm-management': 'providers',
  'llm-providers': 'providers',
  'llm-overview': 'overview',
  'llm-logs': 'logs',
  'llm-budgets': 'budgets',
  'llm-keys': 'keys',
};

export function LlmManagementView({ projectId }: { projectId: string }) {
  const open = useCustomizeStore((s) => s.open);
  const section = useCustomizeStore((s) => s.section);
  const llmProvidersTab = useCustomizeStore((s) => s.llmProvidersTab);
  const [tab, setTab] = useState<LlmTab>(() => TAB_BY_SECTION[section] ?? 'providers');

  // Account default model — the gateway resolves `auto` against this. The picker
  // lives in the tab bar so it's the obvious place to set "my default model",
  // regardless of which sub-tab is open.
  const { data: providers } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const modelDefaults = useModelDefaults(projectId);
  const effectiveDefault = modelDefaults.accountDefault ?? modelDefaults.platformDefault ?? null;

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
        <ModelSelector
          models={models}
          providers={providers}
          selectedModel={effectiveDefault}
          onSelect={(m) => {
            if (m) void modelDefaults.setAccountDefault(m);
          }}
        />
      </div>

      {/* min-h-0 lets each panel actually shrink inside the flex column so
          overflow-y-auto scrolls instead of clipping tall content. */}
      <TabsContent value="providers" className="min-h-0 overflow-y-auto">
        <ProjectProviderModal
          asPanel
          projectId={projectId}
          open={open}
          onOpenChange={() => {}}
          defaultTab={llmProvidersTab}
        />
      </TabsContent>
      <TabsContent value="overview" className="min-h-0 overflow-y-auto">
        <GatewayOverview projectId={projectId} />
      </TabsContent>
      <TabsContent value="logs" className="min-h-0 overflow-y-auto">
        <GatewayLogs projectId={projectId} />
      </TabsContent>
      <TabsContent value="budgets" className="min-h-0 overflow-y-auto">
        <GatewayBudgets projectId={projectId} />
      </TabsContent>
      <TabsContent value="keys" className="min-h-0 overflow-y-auto">
        <GatewayKeys projectId={projectId} />
      </TabsContent>
    </Tabs>
  );
}
