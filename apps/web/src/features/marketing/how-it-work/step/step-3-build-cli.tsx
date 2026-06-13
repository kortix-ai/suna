'use client';

import { DraggableCliPanel } from '@/components/home/interactive-demo/cli/draggable-cli-panel';
import { PageHead, StatusDot } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InlineMeta } from '@/components/ui/inline-meta';
import { cn } from '@/lib/utils';
import { MessageSquare, Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { HiMiniSparkles } from 'react-icons/hi2';
import { StepCliTerminal } from '../step-cli-terminal';
import { useStep3Director } from '../step-director';
import { useStepShowcaseStart } from '../use-step-showcase';
import { WebPanelWrapper } from '../web-panel-wrapper';

function AgentsView({ showAgent, showSkills }: { showAgent: boolean; showSkills: boolean }) {
  return (
    <div className="flex h-full flex-col">
      <PageHead
        title="Agents"
        sub="Each agent is its own worker — defined in .kortix/opencode/agents"
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" /> New agent
          </Button>
        }
      />

      <AnimatePresence>
        {showAgent && (
          <motion.div
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: 'easeOut' }}
            className={cn(
              'border-border/70 bg-card flex flex-col rounded-md border p-3.5',
              showSkills && 'border-kortix-green/30 ring-kortix-green/30 ring-2',
            )}
          >
            <div className="flex items-start gap-3">
              <EntityAvatar icon={MessageSquare} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-sm font-semibold">support-triage</span>
                  <Badge size="sm" variant="muted" className="font-mono">
                    webhook
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-relaxed">
                  Categorizes, prioritizes and routes inbound tickets, drafting an empathetic first
                  reply.
                </p>
              </div>
              <StatusDot on label={['active', 'idle']} />
            </div>

            {showSkills && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="border-border/60 mt-3 space-y-2 border-t pt-2.5"
              >
                <div className="text-muted-foreground text-xs font-medium">Attached skills</div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge size="sm" variant="highlight" className="gap-1 font-mono">
                    <HiMiniSparkles className="size-3" />
                    ticket-summary
                  </Badge>
                </div>
                <InlineMeta>
                  <span>MiniMax M2</span>
                  <span>6,431 runs</span>
                  <span>just now</span>
                </InlineMeta>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!showAgent && (
        <div className="border-border/60 text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed py-12 text-center text-sm">
          Run <span className="text-foreground font-mono">kortix dev</span> to test agents locally.
        </div>
      )}
    </div>
  );
}

export function Step3BuildCli() {
  const director = useStep3Director();
  const rootRef = useStepShowcaseStart(director.start);

  return (
    <div ref={rootRef} className="relative aspect-19/22 w-full overflow-visible">
      <DraggableCliPanel containerRef={rootRef}>
        {({ dragHandleProps }) => (
          <StepCliTerminal director={director} dragHandleProps={dragHandleProps} />
        )}
      </DraggableCliPanel>

      <WebPanelWrapper activeTab="agents">
        <AgentsView showAgent={director.showAgent} showSkills={director.showSkills} />
      </WebPanelWrapper>
    </div>
  );
}
