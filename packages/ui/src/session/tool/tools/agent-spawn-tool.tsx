'use client';

import { SubSessionModal } from '../../thread/sub-session-modal';
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
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import {
  SubAgentActivity,
  SubAgentStatusBanner,
  useSubAgentThread,
} from '../shared/sub-agent';
import type { ToolProps } from '../shared/types';
import { getChildSessionId, getToolInfo } from '../../../internal/session-types';
import { CheckIcon as Check, CpuIcon as Cpu } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useContext, useMemo, useState } from 'react';

import { cleanWorkerOutput } from '@kortix/sdk';
import { subAgentCalls } from '@kortix/sdk';

export function AgentSpawnTool({ call, defaultOpen, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const surface = useContext(ToolSurfaceContext);
  const input = partInput(call);
  const status = partStatus(call);
  const output = partOutput(call);
  // Both walk the input's prose: `getAgentCardLabel` tries up to five fields and
  // `firstMeaningfulLine` splits each one on every newline before taking the
  // first non-blank. A spawn carries a whole prompt, so that is a full scan plus
  // a line array per render — and this row re-renders on every frame of the
  // child session's stream, because `useSubAgentThread` below subscribes to it.
  const description = useMemo(() => getAgentCardLabel(input), [input]);
  const verification = useMemo(
    () => firstMeaningfulLine(input.verification_condition, 120),
    [input],
  );
  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(call), [call]);

  const childThread = useSubAgentThread(childSessionId);
  const childCalls = useMemo(() => subAgentCalls(childThread), [childThread]);

  const [modalOpen, setModalOpen] = useState(false);

  const lastActivity = useMemo(() => {
    if (childCalls.length === 0) return null;
    const last = childCalls[childCalls.length - 1];
    const info = getToolInfo(last.name, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childCalls]);

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
          title: tI18nComplete.raw('text9577487fd26d'),
          subtitle: isRunning
            ? (lastActivity ?? description)
            : spawnFailure
              ? 'failed'
              : description || undefined,
        }}
        onSubtitleClick={hasSession ? () => setModalOpen(true) : undefined}
        badge={
          isCompleted && childCalls.length > 0 ? `${childCalls.length} steps` : undefined
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
        ) : verification || (isCompleted && (cleanedOutput || childCalls.length > 0)) ? (
          <ToolResultCard>
            <div className="space-y-2 px-2 py-1.5">
              {verification && (
                <div className="text-muted-foreground/60 text-xs leading-relaxed">
                  ✓ {verification}
                </div>
              )}

              {isCompleted && cleanedOutput ? (
                <OutputBlock text={cleanedOutput} markdown />
              ) : isCompleted && childCalls.length > 0 ? (
                <div className="space-y-0.5">
                  {childCalls.slice(-3).map((step) => {
                    const info = getToolInfo(step.name, partInput(step) as Record<string, any>);
                    return (
                      <div
                        key={step.id}
                        className="text-muted-foreground flex items-center gap-1.5 truncate text-xs"
                      >
                        <Check className="text-muted-foreground/50 size-2.5 shrink-0" />
                        {info.title}
                        {info.subtitle ? ` · ${info.subtitle}` : ''}
                      </div>
                    );
                  })}
                  {childCalls.length > 3 && (
                    <div className="text-muted-foreground/50 pl-4 text-xs">
                      +{childCalls.length - 3} {tI18nComplete.raw('text187897ce0afc')}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </ToolResultCard>
        ) : null}

        {surface === 'panel' && childCalls.length > 0 && (
          // Full-bleed seam, not a nested box. The panel row body already
          // supplies the 12px gutter this sits in, so a `p-3` here inset the
          // activity list a second time (24px of gutter around a 420px pane)
          // and pulled the hairline in from both edges — a second frame drawn
          // inside the row card's. `-mx-3` cancels the body's horizontal inset
          // so the `border-t` spans the card edge to edge, `px-3` puts the
          // content back where it was, and only the top inset survives.
          <div className="border-border/30 -mx-3 border-t px-3 pt-3">
            <SubAgentActivity childSessionId={childSessionId} calls={childCalls} />
          </div>
        )}

        <SubAgentStatusBanner childSessionId={childSessionId} childThread={childThread} />
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
ToolRegistry.register('agent-spawn', AgentSpawnTool);

ToolRegistry.register('agent-task', AgentSpawnTool);
ToolRegistry.register('agent-task-create', AgentSpawnTool);
ToolRegistry.register('agent-task-start', AgentSpawnTool);
ToolRegistry.register('task-create', AgentSpawnTool);
ToolRegistry.register('task-start', AgentSpawnTool);
