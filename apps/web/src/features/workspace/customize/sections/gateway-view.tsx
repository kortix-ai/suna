'use client';

/**
 * LLM — one Customize section that consolidates the per-project gateway surfaces
 * (Providers, Overview, Logs, Budgets, API keys) behind a single pill-tab bar,
 * so the whole section reads as one consistent surface (no competing tab styles).
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

  // Account default model — the gateway resolves `auto` against this. Shown at
  // the top of the LLM section so it's the obvious place to set "my default
  // model", regardless of which sub-tab is open.
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
      {/* Account default model — the single, obvious place to set "my default". */}
      <div className="border-border/60 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">Default model</div>
          <p className="text-muted-foreground/70 max-w-md text-xs leading-5 text-pretty">
            Used whenever a chat doesn&apos;t have a model picked — across all your projects.
            Picking a model inside a conversation always overrides it.
          </p>
        </div>
        <ModelSelector
          models={models}
          providers={providers}
          selectedModel={effectiveDefault}
          onSelect={(m) => {
            if (m) void modelDefaults.setAccountDefault(m);
          }}
        />
      </div>

      <div className="border-border/60 flex shrink-0 items-center border-b px-5 py-2.5">
        <TabsList>
          {LLM_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="text-xs">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="providers" className="flex min-h-0 flex-col overflow-hidden">
        <ProjectProviderModal
          asPanel
          projectId={projectId}
          open={open}
          onOpenChange={() => {}}
          defaultTab={llmProvidersTab}
        />
      </TabsContent>
      <TabsContent value="overview" className="flex min-h-0 flex-col overflow-hidden">
        <GatewayOverview projectId={projectId} />
      </TabsContent>
      <TabsContent value="logs" className="flex min-h-0 flex-col overflow-hidden">
        <GatewayLogs projectId={projectId} />
      </TabsContent>
      <TabsContent value="budgets" className="flex min-h-0 flex-col overflow-hidden">
        <GatewayBudgets projectId={projectId} />
      </TabsContent>
      <TabsContent value="keys" className="flex min-h-0 flex-col overflow-hidden">
        <GatewayKeys projectId={projectId} />
      </TabsContent>
    </Tabs>
  );
}
