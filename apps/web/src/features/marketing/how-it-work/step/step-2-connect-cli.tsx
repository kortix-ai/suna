'use client';

import { DraggableCliPanel } from '@/components/home/interactive-demo/cli/draggable-cli-panel';
import { INTEGRATIONS, PROVIDERS } from '@/components/home/interactive-demo/data';
import {
  BrandLogo,
  ConnectBadge,
  PageHead,
  Panel,
} from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Blocks, KeyRound } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { HiMiniSparkles } from 'react-icons/hi2';
import { RiCpuLine } from 'react-icons/ri';
import { StepCliTerminal } from '../step-cli-terminal';
import { useStep2Director, type Step2View } from '../step-director';
import { WebPanelWrapper } from '../web-panel-wrapper';

function CostTrackingPanel() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: 'easeOut' }}
    >
      <Panel title="Gateway usage" count="this month">
        <div className="bg-border grid grid-cols-3 gap-px">
          {[
            { label: 'Spend', value: '$12.40' },
            { label: 'Requests', value: '1,284' },
            { label: 'Tokens', value: '4.2M' },
          ].map((stat) => (
            <div key={stat.label} className="bg-card px-3 py-2.5">
              <div className="text-muted-foreground text-xs">{stat.label}</div>
              <div className="text-foreground mt-0.5 font-mono text-sm font-medium">
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </motion.div>
  );
}

function ModelsView({
  connectedDomains,
  showCostPanel,
}: {
  connectedDomains: string[];
  showCostPanel: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHead
        title="Models"
        sub="Bring any provider — routed per session, keys stay in Secrets"
      />

      <div className="space-y-2">
        {PROVIDERS.slice(0, 6).map((p) => {
          const connected = !!p.domain && connectedDomains.includes(p.domain);
          return (
            <motion.div
              key={p.name}
              layout
              className={cn(
                'border-border/60 bg-card flex items-center gap-3 rounded-md border p-2.5 transition-colors',
                connected &&
                  p.domain === 'anthropic.com' &&
                  'border-kortix-green/30 ring-kortix-green/30 ring-2',
              )}
            >
              {p.domain ? (
                <BrandLogo domain={p.domain} alt={p.name} />
              ) : (
                <span className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center rounded-lg">
                  <RiCpuLine className="size-4" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate text-sm font-medium">{p.name}</div>
                <div className="text-muted-foreground truncate text-xs">{p.hint}</div>
              </div>
              {p.state === 'managed' ? (
                <Badge size="sm" variant="highlight" className="shrink-0 gap-1">
                  <HiMiniSparkles className="size-3" /> Managed
                </Badge>
              ) : connected ? (
                <ConnectBadge connected />
              ) : (
                <Button variant="outline" size="sm" className="shrink-0">
                  <KeyRound className="size-3.5" /> Connect
                </Button>
              )}
            </motion.div>
          );
        })}
      </div>

      <div className="border-border/60 bg-muted/20 text-muted-foreground mt-3 flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs">
        <KeyRound className="size-3.5 shrink-0" />
        Connecting a provider writes its API key to Secrets — sessions pick it up at sandbox boot.
      </div>

      <AnimatePresence>
        {showCostPanel && (
          <div className="mt-3">
            <CostTrackingPanel />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function IntegrationsView({ connectedNames }: { connectedNames: string[] }) {
  const featured = INTEGRATIONS.filter(([, name]) =>
    ['GitHub', 'Slack', 'Linear', 'Notion', 'HubSpot', 'Stripe'].includes(name),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h3 className="text-foreground text-lg font-semibold tracking-tight">Integrations</h3>
          <p className="text-muted-foreground mt-0.5 text-sm">
            3,000+ apps · connected once, shared securely across the org
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {featured.map(([domain, name, defaultConnected]) => {
          const connected = defaultConnected || connectedNames.includes(name);
          return (
            <motion.div
              key={name}
              layout
              className={cn(
                'border-border/60 bg-card flex items-center gap-2.5 rounded-md border p-2.5',
                name === 'Linear' &&
                  connected &&
                  'border-kortix-green/30 ring-kortix-green/30 ring-2',
              )}
            >
              <BrandLogo domain={domain} alt={name} />
              <span className="text-foreground truncate text-sm font-medium">{name}</span>
              <ConnectBadge connected={connected} />
            </motion.div>
          );
        })}
      </div>

      <button
        type="button"
        className="border-border/60 bg-muted/20 mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-dashed py-3 text-sm"
      >
        <Blocks className="text-muted-foreground size-4" />
        <span className="text-foreground font-medium">Browse all 3,000+ apps</span>
      </button>
    </div>
  );
}

function WebPanel({
  view,
  connectedProviders,
  connectedConnectors,
  showCostPanel,
}: {
  view: Step2View;
  connectedProviders: string[];
  connectedConnectors: string[];
  showCostPanel: boolean;
}) {
  return (
    <WebPanelWrapper activeTab={view}>
      <AnimatePresence mode="wait">
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          {view === 'models' ? (
            <ModelsView connectedDomains={connectedProviders} showCostPanel={showCostPanel} />
          ) : (
            <IntegrationsView connectedNames={connectedConnectors} />
          )}
        </motion.div>
      </AnimatePresence>
    </WebPanelWrapper>
  );
}

export function Step2ConnectCli() {
  const director = useStep2Director();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          io.disconnect();
          director.start();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={rootRef} className="relative aspect-19/22 w-full overflow-visible">
      <DraggableCliPanel containerRef={rootRef}>
        {({ dragHandleProps }) => (
          <StepCliTerminal director={director} dragHandleProps={dragHandleProps} />
        )}
      </DraggableCliPanel>

      <WebPanel
        view={director.view}
        connectedProviders={director.connectedProviders}
        connectedConnectors={director.connectedConnectors}
        showCostPanel={director.showCostPanel}
      />
    </div>
  );
}
