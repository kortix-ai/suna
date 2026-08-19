'use client';
import { Button } from '@/components/ui/button';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import {
  BasicTool,
  firstMeaningfulLine,
  partInput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useRuntimeMessages } from '@kortix/sdk/react';
import {
  getChildSessionId,
  getChildSessionToolParts,
  getToolInfo,
  type MessageWithParts,
} from '@/ui';
import {
  ArrowSquareOutIcon as ExternalLink,
  KanbanIcon as SquareKanban,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';

/**
 * A task call is a disclosure row: what the sub-agent is doing, in place.
 *
 * This row used to be a plain button that opened `SubSessionModal` on any
 * click. That put the only view of a running sub-agent behind a modal — the
 * reader had to leave the transcript to learn what the agent they just
 * dispatched was up to, and had to close it again to get back — while the
 * `SubAgentActivity` list this component already assembled was unreachable dead
 * code on that path. The steps are the answer to the question the row raises,
 * so they belong under the row, and the modal is now an explicit action inside
 * the body rather than the row's whole behaviour.
 *
 * The trigger is unchanged: while the sub-agent runs its subtitle is that
 * agent's LAST step, so a collapsed row still reports live progress.
 */
export function TaskTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);

  const subagentType = (input.subagent_type as string) || 'general';
  // `firstMeaningfulLine` splits its argument on every newline and trims each
  // segment. A sub-agent prompt is the longest string this row ever sees, and
  // this ran over it on every render of a row that is mostly collapsed.
  const description = useMemo(
    () =>
      (input.description as string) ||
      firstMeaningfulLine(input.prompt) ||
      firstMeaningfulLine(input.title, 80),
    [input],
  );

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(part), [part]);

  const { data: childMessages } = useRuntimeMessages(childSessionId ?? '');

  const childToolParts = useMemo(() => {
    if (!childMessages) return [];
    return getChildSessionToolParts(childMessages as MessageWithParts[]);
  }, [childMessages]);

  const [modalOpen, setModalOpen] = useState(false);
  const openModal = useCallback(() => setModalOpen(true), []);

  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';

  const lastActivity = useMemo(() => {
    if (childToolParts.length === 0) return null;
    const last = childToolParts[childToolParts.length - 1];
    const info = getToolInfo(last.tool, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childToolParts]);

  const subtitle = isRunning ? (lastActivity ?? description) : description || undefined;

  return (
    <>
      <BasicTool
        icon={<SquareKanban className="size-3.5 shrink-0" />}
        trigger={{
          title: `Agent · ${subagentType}`,
          subtitle,
        }}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
        badge={
          isCompleted && childToolParts.length > 0 ? `${childToolParts.length} steps` : undefined
        }
      >
        {childSessionId ? (
          <div className="flex flex-col gap-2">
            <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
            {/* Rendered even before the first step arrives: a sub-agent that has
                only just started has nothing to list, and the full view is then
                the only way to watch it — the body must not be a dead end. */}
            <div className="px-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={openModal}
                className="text-muted-foreground hover:text-foreground -ml-1.5 h-6 gap-1.5 px-1.5 text-xs"
              >
                <ExternalLink className="size-3" />
                Open full view
              </Button>
            </div>
          </div>
        ) : undefined}
      </BasicTool>
      <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
      {childSessionId && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={`Agent · ${subagentType}${description ? `: ${description}` : ''}`}
        />
      )}
    </>
  );
}
ToolRegistry.register('task', TaskTool);
