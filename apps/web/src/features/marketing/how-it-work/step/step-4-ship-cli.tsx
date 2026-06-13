'use client';

import { DraggableCliPanel } from '@/components/home/interactive-demo/cli/draggable-cli-panel';
import { ProjectsPage } from '@/components/home/interactive-demo/pages/projects-page';
import { Panel } from '@/components/home/interactive-demo/primitives';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { StepCliTerminal } from '../step-cli-terminal';
import { useStep4Director, type Step4Member, type Step4View } from '../step-director';
import { useStepShowcaseStart } from '../use-step-showcase';
import { WebPanelWrapper } from '../web-panel-wrapper';

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function TeamView({ members, live }: { members: Step4Member[]; live: boolean }) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-foreground text-lg font-semibold tracking-tight">acme-ops</h3>
            {live && (
              <Badge size="sm" variant="success" className="gap-1">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> live
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">Team joining — one deployment, whole org</p>
        </div>
        <div className="flex -space-x-2">
          <AnimatePresence initial={false}>
            {members.slice(0, 4).map((m, i) => (
              <motion.div
                key={m.email}
                initial={{ opacity: 0, scale: 0.8, x: 12 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                transition={{ delay: i * 0.08, duration: 0.28 }}
              >
                <Avatar
                  className={cn(
                    'border-background size-8 border-2',
                    m.email === 'team@acme.com' && 'ring-kortix-green/40 ring-2',
                  )}
                >
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                    {initials(m.name)}
                  </AvatarFallback>
                </Avatar>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      <Panel title="Members" count={`· ${members.length}`}>
        {members.map((m) => (
          <div
            key={m.email}
            className={cn(
              'border-border flex items-center gap-3 border-b px-4 py-3 last:border-0',
              m.email === 'team@acme.com' && 'bg-kortix-green/5',
            )}
          >
            <Avatar className="size-8">
              <AvatarFallback className="bg-muted text-foreground text-xs font-medium">
                {initials(m.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="text-foreground truncate text-sm font-medium">{m.name}</div>
              <div className="text-muted-foreground truncate text-xs">{m.email}</div>
            </div>
            <Badge size="sm" variant="outline">
              {m.role}
            </Badge>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function WebPanel({
  view,
  project,
  members,
}: {
  view: Step4View;
  project: ReturnType<typeof useStep4Director>['project'];
  members: Step4Member[];
}) {
  return (
    <WebPanelWrapper activeTab={view === 'projects' ? 'projects' : 'security'}>
      <AnimatePresence mode="wait">
        <motion.div
          key={view}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          {view === 'projects' ? (
            <ProjectsPage projects={project ? [project] : []} />
          ) : (
            <TeamView members={members} live={project?.status === 'live'} />
          )}
        </motion.div>
      </AnimatePresence>
    </WebPanelWrapper>
  );
}

export function Step4ShipCli() {
  const director = useStep4Director();
  const rootRef = useStepShowcaseStart(director.start);

  return (
    <div ref={rootRef} className="relative aspect-19/22 w-full overflow-visible">
      <DraggableCliPanel containerRef={rootRef}>
        {({ dragHandleProps }) => (
          <StepCliTerminal director={director} dragHandleProps={dragHandleProps} />
        )}
      </DraggableCliPanel>

      <WebPanel view={director.view} project={director.project} members={director.members} />
    </div>
  );
}
