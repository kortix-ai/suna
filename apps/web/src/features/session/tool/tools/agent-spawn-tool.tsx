'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Badge } from '@/components/ui/badge';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import {
  firstMeaningfulLine,
  getAgentCardLabel,
  partInput,
  partOutput,
  partStatus,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { cn } from '@/lib/utils';
import {
  getChildSessionId,
  getChildSessionToolParts,
  getToolInfo,
  type MessageWithParts,
} from '@/ui';
import { Check, ChevronRight, Cpu, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useContext, useMemo, useState } from 'react';

import {
  cleanWorkerOutput,
  extractWorkerPreview,
  isShortOutput,
} from '@/features/session/tool/shared/agent-helpers';

export function AgentSpawnTool({ part, forceOpen }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const surface = useContext(ToolSurfaceContext);
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const description = getAgentCardLabel(input);
  const verification = firstMeaningfulLine(input.verification_condition, 120);
  const taskIdFromOutput = useMemo(() => {
    const m = (output || '').match(/\btask-[a-z0-9]+/);
    return m ? m[0] : null;
  }, [output]);
  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';
  const isError = status === 'error';

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(part), [part]);

  const { data: childMessages } = useOpenCodeMessages(childSessionId ?? '');
  const childToolParts = useMemo(() => {
    if (!childMessages) return [];
    return getChildSessionToolParts(childMessages as MessageWithParts[]);
  }, [childMessages]);

  const [modalOpen, setModalOpen] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const lastActivity = useMemo(() => {
    if (childToolParts.length === 0) return null;
    const last = childToolParts[childToolParts.length - 1];
    const info = getToolInfo(last.tool, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childToolParts]);

  const cleanedOutput = useMemo(() => cleanWorkerOutput(output), [output]);
  const workerPreview = useMemo(() => extractWorkerPreview(cleanedOutput), [cleanedOutput]);

  const hasSession = !!childSessionId;

  return (
    <>
      <div className={cn('w-full overflow-hidden text-xs')}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => hasSession && setModalOpen(true)}
          onKeyDown={(e) => e.key === 'Enter' && hasSession && setModalOpen(true)}
          className={cn('p-3', hasSession ? 'hover:bg-accent/50 cursor-pointer' : '')}
        >
          <div className="flex items-center gap-2.5">
            <Cpu className="text-muted-foreground size-4 flex-shrink-0" />

            <span className="text-foreground flex-1 truncate text-sm font-medium">
              {description}
            </span>

            {taskIdFromOutput && (
              <span className="text-muted-foreground/50 flex-shrink-0 font-mono text-xs">
                {taskIdFromOutput.slice(-8)}
              </span>
            )}

            {isRunning && (
              <span className="text-muted-foreground bg-muted flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium">
                <Loader2 className="size-2.5 animate-spin" />
                Running
              </span>
            )}
            {isCompleted && childToolParts.length > 0 && (
              <span className="text-muted-foreground bg-muted flex-shrink-0 rounded px-1.5 py-0.5 font-mono text-xs">
                {childToolParts.length} steps
              </span>
            )}
            {isCompleted && childToolParts.length === 0 && !cleanedOutput && (
              <Badge variant="success" size="sm" className="flex-shrink-0 gap-1">
                <Check className="size-2.5" />
                Done
              </Badge>
            )}
            {isError && (
              <span className="text-destructive bg-destructive/10 flex-shrink-0 rounded px-1.5 py-0.5 text-xs font-medium">
                Failed
              </span>
            )}

            {hasSession && (
              <ChevronRight className="text-muted-foreground/20 group-hover:text-muted-foreground/50 size-3.5 flex-shrink-0 transition-colors" />
            )}
          </div>

          {verification && (
            <div className="mt-1 pl-[26px]">
              <span className="text-muted-foreground/40 text-xs leading-relaxed">
                ✓ {verification}
              </span>
            </div>
          )}

          {isRunning && (
            <div className="mt-2 pl-[26px]">
              {lastActivity ? (
                <TextShimmer
                  duration={1.5}
                  spread={2}
                  className="text-muted-foreground truncate font-mono text-xs"
                >
                  {lastActivity}
                </TextShimmer>
              ) : (
                <span className="text-muted-foreground text-xs">
                  {tHardcodedUi.raw('componentsSessionToolRenderers.line6401JsxTextStarting')}
                </span>
              )}
            </div>
          )}

          {isCompleted && childToolParts.length > 0 && !cleanedOutput && (
            <div className="mt-2 space-y-0.5 pl-[26px]">
              {childToolParts.slice(-3).map((tp, i) => {
                const info = getToolInfo(tp.tool, partInput(tp) as Record<string, any>);
                return (
                  <div
                    key={i}
                    className="text-muted-foreground flex items-center gap-1.5 truncate text-xs"
                  >
                    <Check className="text-muted-foreground/50 size-2.5 flex-shrink-0" />
                    {info.title}
                    {info.subtitle ? ` · ${info.subtitle}` : ''}
                  </div>
                );
              })}
              {childToolParts.length > 3 && (
                <div className="text-muted-foreground/50 pl-4 text-xs">
                  +{childToolParts.length - 3} more
                </div>
              )}
            </div>
          )}

          {isCompleted && childToolParts.length === 0 && !cleanedOutput && (
            <div className="mt-1.5 pl-[26px]">
              <span className="text-muted-foreground/50 flex items-center gap-1.5 text-xs">
                <Check className="size-2.5" />
                Completed
              </span>
            </div>
          )}
        </div>

        {isCompleted && cleanedOutput && (
          <div className="border-border/30 border-t">
            {isShortOutput(cleanedOutput) ? (
              <div className="px-3 py-2.5">
                <div className="text-foreground/80 border-border/40 prose-sm [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_p]:text-muted-foreground [&_li]:text-muted-foreground [&_code]:bg-muted/50 [&_hr]:border-border/30 border-l-2 pl-3 text-xs leading-relaxed [&_code]:rounded [&_code]:px-1 [&_code]:text-xs [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-xs [&_h3]:font-medium [&_hr]:my-3 [&_table]:text-xs">
                  <UnifiedMarkdown content={cleanedOutput} isStreaming={false} />
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOutputExpanded(!outputExpanded);
                  }}
                  className="hover:bg-muted/30 flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors"
                >
                  <ChevronRight
                    className={cn(
                      'text-muted-foreground/40 size-3 flex-shrink-0 transition-transform',
                      outputExpanded && 'rotate-90',
                    )}
                  />
                  <span className="text-muted-foreground flex-shrink-0 text-xs font-medium">
                    Result
                  </span>
                  {!outputExpanded && workerPreview && (
                    <span className="text-muted-foreground/40 truncate text-xs">
                      {workerPreview}
                    </span>
                  )}
                </button>
                {outputExpanded && (
                  <div data-scrollable className="max-h-80 overflow-y-auto px-3 pb-3">
                    <div className="text-foreground/80 border-border/40 prose-sm [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_p]:text-muted-foreground [&_li]:text-muted-foreground [&_code]:bg-muted/50 [&_hr]:border-border/30 border-l-2 pl-3 text-xs leading-relaxed [&_code]:rounded [&_code]:px-1 [&_code]:text-xs [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-xs [&_h3]:font-medium [&_hr]:my-3 [&_table]:text-xs">
                      <UnifiedMarkdown content={cleanedOutput} isStreaming={false} />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {surface === 'panel' && childToolParts.length > 0 && (
          <div className="border-border/30 border-t p-3">
            <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
          </div>
        )}

        <div className="px-3 pb-3 empty:hidden">
          <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
        </div>
      </div>

      {hasSession && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={description}
        />
      )}
    </>
  );
}
ToolRegistry.register('agent_spawn', AgentSpawnTool);
ToolRegistry.register('agent-spawn', AgentSpawnTool);

ToolRegistry.register('agent_task', AgentSpawnTool);
ToolRegistry.register('agent-task', AgentSpawnTool);
ToolRegistry.register('agent_task_create', AgentSpawnTool);
ToolRegistry.register('agent-task-create', AgentSpawnTool);
ToolRegistry.register('agent_task_start', AgentSpawnTool);
ToolRegistry.register('agent-task-start', AgentSpawnTool);
ToolRegistry.register('task_create', AgentSpawnTool);
ToolRegistry.register('task-create', AgentSpawnTool);
ToolRegistry.register('task_start', AgentSpawnTool);
ToolRegistry.register('task-start', AgentSpawnTool);
