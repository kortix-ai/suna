'use client';

import { SubSessionModal } from '@/features/session/sub-session-modal';
import {
  BasicTool,
  firstMeaningfulLine,
  getAgentCardLabel,
  parseJsonFailure,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  getChildSessionId,
  getChildSessionToolParts,
  getToolInfo,
  type MessageWithParts,
} from '@/ui';
import { useRuntimeMessages } from '@kortix/sdk/react';
import { CheckIcon as Check, CpuIcon as Cpu } from '@phosphor-icons/react';
import { useContext, useMemo, useState } from 'react';

import { cleanWorkerOutput } from '@/features/session/tool/shared/agent-helpers';

export function AgentSpawnTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const surface = useContext(ToolSurfaceContext);
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  // Both walk the input's prose: `getAgentCardLabel` tries up to five fields and
  // `firstMeaningfulLine` splits each one on every newline before taking the
  // first non-blank. A spawn carries a whole prompt, so that is a full scan plus
  // a line array per render — and this row re-renders on every frame of the
  // child session's stream, because `useRuntimeMessages` below subscribes to it.
  const description = useMemo(() => getAgentCardLabel(input), [input]);
  const verification = useMemo(
    () => firstMeaningfulLine(input.verification_condition, 120),
    [input],
  );
  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(part), [part]);

  const { data: childMessages } = useRuntimeMessages(childSessionId ?? '');
  const childToolParts = useMemo(() => {
    if (!childMessages) return [];
    return getChildSessionToolParts(childMessages as MessageWithParts[]);
  }, [childMessages]);

  const [modalOpen, setModalOpen] = useState(false);

  const lastActivity = useMemo(() => {
    if (childToolParts.length === 0) return null;
    const last = childToolParts[childToolParts.length - 1];
    const info = getToolInfo(last.tool, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childToolParts]);

  const cleanedOutput = useMemo(() => cleanWorkerOutput(output), [output]);
  const spawnFailure = useMemo(
    () => (isCompleted ? parseJsonFailure(output) : null),
    [isCompleted, output],
  );

  const hasSession = !!childSessionId;

  return (
    <>
      <BasicTool
        icon={<Cpu className="size-3.5 shrink-0" />}
        trigger={{
          title: 'Spawn agent',
          subtitle: isRunning
            ? (lastActivity ?? description)
            : spawnFailure
              ? 'failed'
              : description || undefined,
        }}
        onSubtitleClick={hasSession ? () => setModalOpen(true) : undefined}
        badge={
          isCompleted && childToolParts.length > 0 ? `${childToolParts.length} steps` : undefined
        }
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
      >
        {/* The verification condition and whatever the worker returned are one
				    object — what the agent was asked to guarantee, and what came back —
				    so they share a single card rather than floating as two bare blocks.
				    `ToolOutputFallback` brings its own card, so the failure branch stays
				    outside this one; nesting them would double the border. */}
        {isCompleted && spawnFailure ? (
          <>
            {verification && (
              <ToolResultCard>
                <div className="text-muted-foreground/60 px-2 py-1.5 text-xs leading-relaxed">
                  ✓ {verification}
                </div>
              </ToolResultCard>
            )}
            <ToolOutputFallback output={output} toolName="agent_spawn" />
          </>
        ) : verification || (isCompleted && (cleanedOutput || childToolParts.length > 0)) ? (
          <ToolResultCard>
            <div className="space-y-2 px-2 py-1.5">
              {verification && (
                <div className="text-muted-foreground/60 text-xs leading-relaxed">
                  ✓ {verification}
                </div>
              )}

              {isCompleted && cleanedOutput ? (
                <OutputBlock text={cleanedOutput} markdown />
              ) : isCompleted && childToolParts.length > 0 ? (
                <div className="space-y-0.5">
                  {childToolParts.slice(-3).map((tp, i) => {
                    const info = getToolInfo(tp.tool, partInput(tp) as Record<string, any>);
                    return (
                      <div
                        key={i}
                        className="text-muted-foreground flex items-center gap-1.5 truncate text-xs"
                      >
                        <Check className="text-muted-foreground/50 size-2.5 shrink-0" />
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
              ) : null}
            </div>
          </ToolResultCard>
        ) : null}

        {surface === 'panel' && childToolParts.length > 0 && (
          <div className="border-border/30 border-t p-3">
            <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
          </div>
        )}

        <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
      </BasicTool>

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
