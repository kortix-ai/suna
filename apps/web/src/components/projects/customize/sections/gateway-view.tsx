'use client';

/**
 * LLM — one Customize section that consolidates the per-project gateway surfaces
 * (Providers, Overview, Logs, Budgets, API keys) behind a single clean tab bar.
 *
 * The active tab is LOCAL state, so switching tabs never touches the main
 * Customize rail. Deep-links / `openCustomize('llm-providers')` set the store
 * section, which we read once (and follow on change) to pick the initial tab —
 * Providers is the default, core surface.
 */

import { useEffect, useState } from 'react';
import { Boxes, Gauge, KeyRound, ScrollText, Wallet, type LucideIcon } from 'lucide-react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { GatewayBudgets } from '@/components/projects/gateway/gateway-budgets';
import { GatewayKeys } from '@/components/projects/gateway/gateway-keys';
import { GatewayLogs } from '@/components/projects/gateway/gateway-logs';
import { GatewayOverview } from '@/components/projects/gateway/gateway-overview';
import { ProjectProviderModal } from '@/components/projects/project-provider-modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CustomizeSection } from '@/lib/customize-sections';
import { useCustomizeStore } from '@/stores/customize-store';

type LlmTab = 'providers' | 'overview' | 'logs' | 'budgets' | 'keys';

const LLM_TABS: { id: LlmTab; label: string; icon: LucideIcon }[] = [
  { id: 'providers', label: 'Providers', icon: Boxes },
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'budgets', label: 'Budgets', icon: Wallet },
  { id: 'keys', label: 'API keys', icon: KeyRound },
];

const TAB_BY_SECTION: Partial<Record<CustomizeSection, LlmTab>> = {
  'llm-providers': 'providers',
  'llm-overview': 'overview',
  'llm-logs': 'logs',
  'llm-budgets': 'budgets',
  'llm-keys': 'keys',
};

const PANEL_CLASS = 'mt-0 flex min-h-0 flex-1 flex-col overflow-hidden';

export function LlmManagementView({ projectId }: { projectId: string }) {
  const open = useCustomizeStore((s) => s.open);
  const section = useCustomizeStore((s) => s.section);
  const [tab, setTab] = useState<LlmTab>(() => TAB_BY_SECTION[section] ?? 'providers');

  // Follow an external deep-link (e.g. openCustomize('llm-providers')) to its
  // tab. Plain in-view tab clicks stay local and never move the main rail.
  useEffect(() => {
    const next = TAB_BY_SECTION[section];
    if (next) setTab(next);
  }, [section]);

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionHeader icon={Boxes} title="LLM" />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as LlmTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="border-border/60 flex shrink-0 items-center border-b px-4 py-2">
          <TabsList variant="secondary" size="sm">
            {LLM_TABS.map((t) => {
              const Icon = t.icon;
              return (
                <TabsTrigger key={t.id} value={t.id} className="gap-1.5 px-3">
                  <Icon className="size-3.5" />
                  {t.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value="providers" className={PANEL_CLASS}>
          <ProjectProviderModal
            asPanel
            projectId={projectId}
            open={open}
            onOpenChange={() => {}}
            defaultTab="connected"
          />
        </TabsContent>
        <TabsContent value="overview" className={PANEL_CLASS}>
          <GatewayOverview projectId={projectId} />
        </TabsContent>
        <TabsContent value="logs" className={PANEL_CLASS}>
          <GatewayLogs projectId={projectId} />
        </TabsContent>
        <TabsContent value="budgets" className={PANEL_CLASS}>
          <GatewayBudgets projectId={projectId} />
        </TabsContent>
        <TabsContent value="keys" className={PANEL_CLASS}>
          <GatewayKeys projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
