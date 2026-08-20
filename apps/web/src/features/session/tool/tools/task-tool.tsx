'use client';
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
import { cn } from '@/lib/utils';
import {
  getChildSessionId,
  getChildSessionToolParts,
  getToolInfo,
  type MessageWithParts,
} from '@/ui';
import { useRuntimeMessages } from '@kortix/sdk/react';
import { KanbanIcon as SquareKanban } from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';

/**
 * The way into the sub-agent's own session, pinned to the right edge of the row.
 *
 * It used to be a ghost `Button` at the BOTTOM of the disclosure body, and that
 * was wrong twice over. It sat at the body's left margin — the chain's icon
 * gutter — so it read as one more step in the sub-agent's list rather than as
 * an action on the agent. And it was reachable only by expanding the row, which
 * is backwards for a sub-agent that has not produced a step yet: that is the
 * one moment the full view is the ONLY thing there is to look at.
 *
 * A `span role="button"`, not a `<button>`. This node renders inside the
 * disclosure's trigger, and `DisclosureTrigger` clones that trigger into its own
 * `role="button"` element — a button nested in a button is invalid HTML. The
 * subtitle link in `InlineTriggerTitle` is the same shape for the same reason.
 * Both activation paths `stopPropagation` so reaching the full view does not
 * also toggle the row underneath it.
 *
 * Visible label "Full view", accessible name "Open full view". The row already
 * carries a title plus a live subtitle that has to truncate, so the right edge
 * gets the two words that matter; the longer name rides on `aria-label` and
 * `title`, and it CONTAINS the visible text, so WCAG 2.5.3 (Label in Name)
 * holds.
 *
 * Always visible, never hover-revealed: a hover-only affordance does not exist
 * on touch, and this is the only route to a running sub-agent's full transcript.
 */
function FullViewAction({ onOpen }: { onOpen: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="Open full view"
      title="Open full view"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        'text-muted-foreground/60 hover:text-foreground',
        'flex cursor-pointer items-center gap-1 whitespace-nowrap',
        'underline-offset-2 transition-colors hover:underline',
      )}
    >
      View
    </span>
  );
}

/**
 * A task call is a disclosure row: what the sub-agent is doing, in place.
 *
 * This row used to be a plain button that opened `SubSessionModal` on any
 * click. That put the only view of a running sub-agent behind a modal — the
 * reader had to leave the transcript to learn what the agent they just
 * dispatched was up to, and had to close it again to get back — while the
 * `SubAgentActivity` list this component already assembled was unreachable dead
 * code on that path. The steps are the answer to the question the row raises,
 * so they belong under the row, and the modal is now an explicit action on the
 * row rather than the row's whole behaviour.
 *
 * The trigger is unchanged: while the sub-agent runs its subtitle is that
 * agent's LAST step, so a collapsed row still reports live progress.
 *
 * The body is the sub-agent's steps and NOTHING else, so it is passed only when
 * there are steps. A disclosure whose body is empty is a caret that promises a
 * body and opens onto nothing — the same verdict `ActivityBurst` reaches for a
 * burst that merges to zero rows. Before the full view moved to the trigger,
 * that button was the sole occupant of the body of a just-started sub-agent,
 * which is what kept the empty case from being empty.
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
        triggerAction={childSessionId ? <FullViewAction onOpen={openModal} /> : undefined}
      >
        {childSessionId && childToolParts.length > 0 ? (
          <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
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
