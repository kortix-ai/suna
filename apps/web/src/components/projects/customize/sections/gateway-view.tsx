'use client';

/**
 * LLM Management — one Customize section that consolidates the per-project
 * gateway surfaces (Providers, Overview, Logs, Budgets, API keys) behind a
 * single left sub-rail, mirroring the Connectors master/detail layout.
 *
 * Providers is the core tab and the default landing surface. The other tabs
 * give granular control without cluttering the main Customize rail. The active
 * tab is driven by the customize-store section (`llm-providers`, `llm-logs`, …)
 * so deep-links and `openCustomize('llm-providers')` keep working.
 */

import { Boxes, Gauge, KeyRound, ScrollText, Wallet, type LucideIcon } from 'lucide-react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { GatewayBudgets } from '@/components/projects/gateway/gateway-budgets';
import { GatewayKeys } from '@/components/projects/gateway/gateway-keys';
import { GatewayLogs } from '@/components/projects/gateway/gateway-logs';
import { GatewayOverview } from '@/components/projects/gateway/gateway-overview';
import { ProjectProviderModal } from '@/components/projects/project-provider-modal';
import type { CustomizeSection } from '@/lib/customize-sections';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';

type LlmTab = 'providers' | 'overview' | 'logs' | 'budgets' | 'keys';

const LLM_TABS: { id: LlmTab; label: string; icon: LucideIcon; section: CustomizeSection }[] = [
  { id: 'providers', label: 'Providers', icon: Boxes, section: 'llm-providers' },
  { id: 'overview', label: 'Overview', icon: Gauge, section: 'llm-overview' },
  { id: 'logs', label: 'Logs', icon: ScrollText, section: 'llm-logs' },
  { id: 'budgets', label: 'Budgets', icon: Wallet, section: 'llm-budgets' },
  { id: 'keys', label: 'API keys', icon: KeyRound, section: 'llm-keys' },
];

const TAB_BY_SECTION: Partial<Record<CustomizeSection, LlmTab>> = {
  'llm-providers': 'providers',
  'llm-overview': 'overview',
  'llm-logs': 'logs',
  'llm-budgets': 'budgets',
  'llm-keys': 'keys',
};

export function LlmManagementView({ projectId }: { projectId: string }) {
  const open = useCustomizeStore((s) => s.open);
  const section = useCustomizeStore((s) => s.section);
  const setSection = useCustomizeStore((s) => s.setSection);
  const tab: LlmTab = TAB_BY_SECTION[section] ?? 'providers';

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionHeader icon={Boxes} title="LLM Management" />
      <div className="flex min-h-0 flex-1">
        <nav className="border-border/60 bg-muted/20 flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
          {LLM_TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSection(t.section)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    active ? 'text-foreground' : 'text-muted-foreground/70',
                  )}
                />
                <span className="truncate">{t.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {tab === 'providers' && (
            <ProjectProviderModal
              asPanel
              projectId={projectId}
              open={open}
              onOpenChange={() => {}}
              defaultTab="connected"
            />
          )}
          {tab === 'overview' && <GatewayOverview projectId={projectId} />}
          {tab === 'logs' && <GatewayLogs projectId={projectId} />}
          {tab === 'budgets' && <GatewayBudgets projectId={projectId} />}
          {tab === 'keys' && <GatewayKeys projectId={projectId} />}
        </div>
      </div>
    </div>
  );
}
