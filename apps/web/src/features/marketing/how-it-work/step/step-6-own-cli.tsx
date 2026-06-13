'use client';

import { DraggableCliPanel } from '@/components/home/interactive-demo/cli/draggable-cli-panel';
import { PageHead, Panel } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Cloud, Github, Server, Shield } from 'lucide-react';
import { motion } from 'motion/react';
import { StepCliTerminal } from '../step-cli-terminal';
import { useStep6Director, type Step6Host } from '../step-director';
import { useStepShowcaseStart } from '../use-step-showcase';
import { WebPanelWrapper } from '../web-panel-wrapper';

const HOSTS: { id: Step6Host; label: string; desc: string }[] = [
  { id: 'managed', label: 'Managed cloud', desc: 'kortix.com — fully hosted' },
  { id: 'my-vpc', label: 'my-vpc', desc: 'Your VPC — same stack, your network' },
  { id: 'on-prem', label: 'On-prem', desc: 'Bare metal or private datacenter' },
  { id: 'air-gapped', label: 'Air-gapped', desc: 'No outbound — fully isolated' },
];

function OwnView({ activeHost, dockerRunning }: { activeHost: Step6Host; dockerRunning: boolean }) {
  return (
    <div className="flex h-full flex-col">
      <PageHead
        title="Open source"
        sub="Star it, fork it, run it — the same product everywhere"
        action={
          <Badge size="sm" variant="outline" className="gap-1.5 font-mono">
            <Github className="size-3.5" />
            19.8k
          </Badge>
        }
      />

      {dockerRunning && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="border-border/60 bg-muted/20 mb-4 flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs"
        >
          <Server className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-foreground font-medium">Kortix Cloud</span>
          <span className="text-muted-foreground">running locally via Docker</span>
          <Badge size="sm" variant="success" className="ml-auto gap-1">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> up
          </Badge>
        </motion.div>
      )}

      <Panel title="Hosts" count="switch anytime">
        <div className="divide-border divide-y">
          {HOSTS.map((host) => {
            const highlighted = activeHost === host.id;
            return (
              <div
                key={host.id}
                className={cn(
                  'flex items-center gap-3 px-4 py-3',
                  highlighted && 'bg-kortix-green/5',
                )}
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-lg border',
                    highlighted
                      ? 'border-kortix-green/20 bg-kortix-green/10 text-kortix-green'
                      : 'border-border bg-background text-muted-foreground',
                  )}
                >
                  {host.id === 'air-gapped' ? (
                    <Shield className="size-4" />
                  ) : (
                    <Cloud className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium">{host.label}</div>
                  <div className="text-muted-foreground text-xs">{host.desc}</div>
                </div>
                {highlighted && (
                  <Badge size="sm" variant="success">
                    active
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

export function Step6OwnCli() {
  const director = useStep6Director();
  const rootRef = useStepShowcaseStart(director.start);

  return (
    <div ref={rootRef} className="relative aspect-19/22 w-full overflow-visible">
      <DraggableCliPanel containerRef={rootRef}>
        {({ dragHandleProps }) => (
          <StepCliTerminal director={director} dragHandleProps={dragHandleProps} />
        )}
      </DraggableCliPanel>

      <WebPanelWrapper activeTab="projects">
        <OwnView activeHost={director.activeHost} dockerRunning={director.dockerRunning} />
      </WebPanelWrapper>
    </div>
  );
}
