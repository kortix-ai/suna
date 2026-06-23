'use client';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { IconClose } from '@/components/ui/kortix-icons';
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { getProjectDetail } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useGatewayOverlayStore, type GatewaySection } from '@/stores/gateway-overlay-store';
import { DEFAULT_MANAGED_MODEL_IDS } from '@kortix/shared/llm-catalog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Boxes,
  DollarSign,
  FlaskConical,
  KeyRound,
  Plug,
  RefreshCw,
  ScrollText,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { GatewayBudgets } from './gateway-budgets';
import { GatewayCost } from './gateway-cost';
import { GatewayKeys } from './gateway-keys';
import { GatewayLogs } from './gateway-logs';
import { GatewayOverview } from './gateway-overview';
import { GatewayPlayground } from './gateway-playground';
import { GatewayUsage } from './gateway-usage';

export const MANAGED_MODEL_ID_SET = new Set<string>(DEFAULT_MANAGED_MODEL_IDS);

export const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';
export const LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME = 'OPENCODE_AUTH_JSON';

const SECTIONS: { id: GatewaySection; label: string; description: string; icon: LucideIcon }[] = [
  {
    id: 'overview',
    label: 'Overview',
    description: "At-a-glance spend, requests, errors, and tokens across this project's gateway.",
    icon: Activity,
  },
  {
    id: 'cost',
    label: 'Cost',
    description:
      'Where spend goes — daily cost, cost by model, and total cost per session (LLM + compute).',
    icon: DollarSign,
  },
  {
    id: 'usage',
    label: 'Usage',
    description: 'Traffic and health — requests, tokens, latency percentiles, and errors by type.',
    icon: BarChart3,
  },
  {
    id: 'logs',
    label: 'Logs',
    description:
      'Every LLM request routed through the gateway — model, status, latency, tokens, and cost.',
    icon: ScrollText,
  },
  {
    id: 'budgets',
    label: 'Budgets',
    description: 'Cap spend per project and per member — and see who is spending what this month.',
    icon: Wallet,
  },
  {
    id: 'keys',
    label: 'API keys',
    description: 'Project-scoped keys for calling the gateway from external apps.',
    icon: KeyRound,
  },
  {
    id: 'playground',
    label: 'Playground',
    description: 'Run a prompt across models and compare output, latency, and tokens.',
    icon: FlaskConical,
  },
  {
    id: 'models',
    label: 'Models',
    description: 'Browse the full model catalog available to this project.',
    icon: Boxes,
  },
  {
    id: 'providers',
    label: 'Providers',
    description:
      'Connect your own provider keys (BYOK) — stored per-project and injected into every new session.',
    icon: Plug,
  },
];

export function GatewayOverlay({ projectId }: { projectId: string }) {
  const open = useGatewayOverlayStore((s) => s.open);
  const section = useGatewayOverlayStore((s) => s.section);
  const setSection = useGatewayOverlayStore((s) => s.setSection);
  const close = useGatewayOverlayStore((s) => s.close);

  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: open && !!projectId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const projectName = detail.data?.project?.name ?? '';
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all(
        [
          'project-gateway-overview',
          'project-gateway-series',
          'project-gateway-breakdown',
          'project-gateway-sessions',
          'project-gateway-errors',
          'project-gateway-logs',
          'project-gateway-budgets',
          'project-gateway-keys',
        ].map((key) => queryClient.refetchQueries({ queryKey: [key, projectId], type: 'active' })),
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          'inset-0 h-screen max-h-screen w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 shadow-none',
          'sm:max-w-none sm:rounded-none',
        )}
      >
        <DialogTitle className="sr-only">Gateway · {projectName || 'project'}</DialogTitle>

        <div className="border-border/60 flex h-14 shrink-0 items-center justify-between border-b pr-3 pl-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="bg-primary/10 text-primary flex size-7 items-center justify-center rounded-lg">
              <Activity className="size-4" />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-foreground text-sm font-semibold">Gateway</span>
              {projectName && (
                <span className="bg-muted text-muted-foreground truncate rounded-full px-2 py-0.5 text-xs">
                  {projectName}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={refreshAll}
              disabled={refreshing}
              aria-label="Refresh stats"
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-lg transition-colors duration-150 disabled:opacity-60"
            >
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-lg transition-colors duration-150"
            >
              <IconClose className="size-4" />
            </button>
          </div>
        </div>

        <div className="bg-background flex min-h-0 flex-1">
          <nav className="border-border/50 flex w-56 shrink-0 flex-col border-r p-3">
            <div className="text-muted-foreground/50 px-2.5 pb-2 text-xs font-medium tracking-wide uppercase">
              Gateway
            </div>
            <div className="flex flex-col gap-0.5">
              {SECTIONS.map((s) => {
                const isActive = section === s.id;
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    className={cn(
                      'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-all duration-150',
                      isActive
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-4 shrink-0 transition-transform duration-150',
                        isActive ? '' : 'group-hover:scale-110',
                      )}
                    />
                    <span className="flex-1 text-left">{s.label}</span>
                    {isActive && <span className="bg-primary size-1.5 rounded-full" />}
                  </button>
                );
              })}
            </div>
          </nav>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-border/50 flex shrink-0 items-center gap-3 border-b px-6 py-3">
              <div className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-xl">
                <active.icon className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="text-foreground text-base font-semibold">{active.label}</div>
                <div className="text-muted-foreground truncate text-xs">{active.description}</div>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {section === 'overview' && <GatewayOverview projectId={projectId} />}
              {section === 'cost' && <GatewayCost projectId={projectId} />}
              {section === 'usage' && <GatewayUsage projectId={projectId} />}
              {section === 'logs' && <GatewayLogs projectId={projectId} />}
              {section === 'budgets' && <GatewayBudgets projectId={projectId} />}
              {section === 'keys' && <GatewayKeys projectId={projectId} />}
              {section === 'playground' && <GatewayPlayground projectId={projectId} />}
              {section === 'models' && (
                <ProjectProviderModal
                  asPanel
                  allowedTabs={['models']}
                  defaultTab="models"
                  projectId={projectId}
                  open={open}
                  onOpenChange={() => {}}
                />
              )}
              {section === 'providers' && (
                <ProjectProviderModal
                  asPanel
                  allowedTabs={['connected', 'catalog']}
                  defaultTab="connected"
                  projectId={projectId}
                  open={open}
                  onOpenChange={() => {}}
                />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
