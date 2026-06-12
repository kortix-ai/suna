'use client';

import { DraggableCliPanel } from '@/components/home/interactive-demo/cli/draggable-cli-panel';
import { Panel } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { GitBranch, GitMerge, MessageSquare } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { StepCliTerminal } from '../step-cli-terminal';
import { useStep5Director, type Step5Phase } from '../step-director';
import { useStepShowcaseStart } from '../use-step-showcase';
import { WebPanelWrapper } from '../web-panel-wrapper';

const PROMPT = 'triage today\u2019s tickets';

function RunView({
  phase,
  sessionId,
  branch,
  crNumber,
}: {
  phase: Step5Phase;
  sessionId: string;
  branch: string;
  crNumber: number;
}) {
  const showSession = phase !== 'idle';
  const showChat = phase === 'working' || phase === 'cr-open' || phase === 'cr-merged';
  const showCr = phase === 'cr-open' || phase === 'cr-merged';
  const crMerged = phase === 'cr-merged';

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground mb-4 flex flex-wrap items-center gap-2 text-xs">
        <MessageSquare className="size-3.5" />
        <span>sessions / {showSession ? sessionId : '…'}</span>
        {showSession && (
          <Badge size="sm" variant="outline" className="gap-1 font-mono">
            <GitBranch className="size-3" />
            {branch}
          </Badge>
        )}
      </div>

      <div className="flex-1 space-y-3">
        {showChat && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3"
          >
            <div className="bg-primary/10 text-foreground ml-auto max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm">
              {PROMPT}
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
              {crMerged ? 'Agent finished — CR opened' : 'Agent working…'}
            </div>
          </motion.div>
        )}

        <AnimatePresence>
          {showCr && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Panel
                title={`Change request #${crNumber}`}
                action={
                  <Badge size="sm" variant={crMerged ? 'success' : 'highlight'} className="gap-1">
                    {crMerged ? (
                      <>
                        <GitMerge className="size-3" /> merged
                      </>
                    ) : (
                      'open'
                    )}
                  </Badge>
                }
              >
                <div
                  className={cn(
                    'px-4 py-3 text-sm',
                    crMerged ? 'text-muted-foreground' : 'text-foreground',
                  )}
                >
                  {crMerged
                    ? 'Ticket triage updates merged into main — auditable Git history.'
                    : 'Review agent changes from this session before merging to main.'}
                </div>
              </Panel>
            </motion.div>
          )}
        </AnimatePresence>

        {!showSession && (
          <div className="border-border/60 text-muted-foreground flex flex-1 items-center justify-center rounded-md border border-dashed py-12 text-sm">
            Run <span className="text-foreground mx-1 font-mono">kortix sessions create</span> to
            start.
          </div>
        )}
      </div>
    </div>
  );
}

export function Step5RunCli() {
  const director = useStep5Director();
  const rootRef = useStepShowcaseStart(director.start);

  return (
    <div ref={rootRef} className="relative aspect-19/22 w-full overflow-visible">
      <DraggableCliPanel containerRef={rootRef}>
        {({ dragHandleProps }) => (
          <StepCliTerminal director={director} dragHandleProps={dragHandleProps} />
        )}
      </DraggableCliPanel>

      <WebPanelWrapper activeTab="chat">
        <RunView
          phase={director.phase}
          sessionId={director.sessionId}
          branch={director.branch}
          crNumber={director.crNumber}
        />
      </WebPanelWrapper>
    </div>
  );
}
