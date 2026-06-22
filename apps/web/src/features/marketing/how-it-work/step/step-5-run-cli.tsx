'use client';

import { DraggableCliPanel } from '@/components/home/interactive-demo/cli/draggable-cli-panel';
import { Panel } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { GitBranch, Message as MessageSquare } from '@mynaui/icons-react';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { STEP_CLI_PANEL_ANCHOR, StepCliTerminal } from '../step-cli-terminal';
import { useStep5Director, type Step5Phase } from '../step-director';
import { useStepShowcaseStart } from '../use-step-showcase';
import { WebPanelWrapper } from '../web-panel-wrapper';

function RunView({
  phase,
  sessionId,
  branch,
}: {
  phase: Step5Phase;
  sessionId: string;
  branch: string;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const showSession = phase !== 'idle';
  const showWorking = phase === 'working';

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground mb-4 flex flex-wrap items-center gap-2 text-xs">
        <MessageSquare className="size-3.5" />
        <span>
          {tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep5RunCli0e74f75e')}
          {showSession ? sessionId : '…'}
        </span>
        {showSession && (
          <Badge size="sm" variant="outline" className="gap-1 font-mono">
            <GitBranch className="size-3" />
            {branch}
          </Badge>
        )}
      </div>

      <div className="flex-1 space-y-3">
        {showSession && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3"
          >
            <Panel
              title={tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep5RunCli99e75001')}
              count={tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep5RunClia54c8d26')}
            >
              <div className="text-muted-foreground space-y-2 px-4 py-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-foreground font-mono">{branch}</span>
                  <Badge size="sm" variant="outline">
                    {tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep5RunCli8317f345')}
                  </Badge>
                </div>
                {showWorking && (
                  <div className="flex items-center gap-2">
                    <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                    {tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep5RunCli8354de66')}
                  </div>
                )}
              </div>
            </Panel>
          </motion.div>
        )}

        {!showSession && (
          <div className="border-border/60 text-muted-foreground flex flex-1 items-center justify-center rounded-md border border-dashed py-12 text-sm">
            Run{' '}
            <span className="text-foreground mx-1 font-mono">
              {tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep5RunCli7d7494d3')}
            </span>{' '}
            {tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep5RunCliadb5f23c')}
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
      <DraggableCliPanel containerRef={rootRef} initialAnchor={STEP_CLI_PANEL_ANCHOR}>
        {({ dragHandleProps }) => (
          <StepCliTerminal director={director} dragHandleProps={dragHandleProps} />
        )}
      </DraggableCliPanel>

      <WebPanelWrapper activeTab="chat">
        <RunView phase={director.phase} sessionId={director.sessionId} branch={director.branch} />
      </WebPanelWrapper>
    </div>
  );
}
