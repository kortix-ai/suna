'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Boxes,
  FlaskConical,
  KeyRound,
  type LucideIcon,
  Plug,
  RefreshCw,
  ScrollText,
  Wallet,
} from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { IconClose } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';
import { getProjectDetail } from '@/lib/projects-client';
import { useGatewayOverlayStore, type GatewaySection } from '@/stores/gateway-overlay-store';

import { ProjectProviderModal } from '@/components/projects/project-provider-modal';

import { GatewayOverview } from './gateway-overview';
import { GatewayLogs } from './gateway-logs';
import { GatewayBudgets } from './gateway-budgets';
import { GatewayKeys } from './gateway-keys';
import { GatewayPlayground } from './gateway-playground';

const SECTIONS: { id: GatewaySection; label: string; description: string; icon: LucideIcon }[] = [
  {
    id: 'overview',
    label: 'Overview',
    description: "Spend, requests, and errors across this project's gateway.",
    icon: Activity,
  },
  {
    id: 'logs',
    label: 'Logs',
    description: 'Every LLM request routed through the gateway — model, status, latency, tokens, and cost.',
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
    description: 'Connect your own provider keys (BYOK) — stored per-project and injected into every new session.',
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
          'project-gateway-errors',
          'project-gateway-logs',
          'project-gateway-budgets',
          'project-gateway-keys',
        ].map((key) =>
          queryClient.refetchQueries({ queryKey: [key, projectId], type: 'active' }),
        ),
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
          'inset-0 h-screen w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 shadow-none',
        )}
      >
        <DialogTitle className="sr-only">Gateway · {projectName || 'project'}</DialogTitle>

        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 pl-4 pr-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Activity className="size-4" />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-sm font-semibold text-foreground">Gateway</span>
              {projectName && (
                <span className="truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
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
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-60"
            >
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              <IconClose className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 bg-background">
          <nav className="flex w-56 shrink-0 flex-col border-r border-border/50 p-3">
            <div className="px-2.5 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/50">
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
                        ? 'bg-primary/10 font-medium text-primary'
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
                    {isActive && <span className="size-1.5 rounded-full bg-primary" />}
                  </button>
                );
              })}
            </div>
          </nav>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-6 py-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <active.icon className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="text-base font-semibold text-foreground">{active.label}</div>
                <div className="truncate text-xs text-muted-foreground">{active.description}</div>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {section === 'overview' && <GatewayOverview projectId={projectId} />}
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
