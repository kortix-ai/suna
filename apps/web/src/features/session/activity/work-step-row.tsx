'use client';

/**
 * One step inside an expanded work line.
 *
 * The point of expanding "21 steps" is to opt back INTO the complexity, so a
 * step that is only text is a dead end — you have read the label and there is
 * nowhere left to go. Every row here is therefore actionable:
 *
 *  - **In a session** (`ToolActivateContext` is provided): clicking opens the
 *    side panel focused on that exact tool call — the same destination every
 *    other tool row in the transcript navigates to. This is the default,
 *    because the panel is where output is meant to be read.
 *  - **Without a panel** (the variant demo, read-only sub-session views,
 *    onboarding): clicking expands the real `ToolPartRenderer` inline, so the
 *    full output — terminal included — is still one click away.
 *
 * Either way the row shows the human label at rest and never the raw command.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import Loading from '@/components/ui/loading';
import { ToolActivateContext, ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { cn } from '@/lib/utils';
import type { ToolPart } from '@/ui';
import { ChevronRight, PanelRight } from 'lucide-react';
import { useContext, useState } from 'react';
import { formatActivityDuration, isPartRunning } from './activity-model';
import { stepDetail } from './step-label';

function durationOf(part: ToolPart): string {
  const time = (part.state as { time?: { start?: number; end?: number } } | undefined)?.time;
  if (typeof time?.start !== 'number' || typeof time?.end !== 'number') return '';
  return formatActivityDuration(time.end - time.start);
}

export function WorkStepRow({
  part,
  sessionId,
  /** Forces the inline-expand behaviour even inside a session — used by
   *  read-only surfaces and onboarding, where navigating away is wrong. */
  disableNavigation,
}: {
  part: ToolPart;
  sessionId?: string;
  disableNavigation?: boolean;
}) {
  const onActivate = useContext(ToolActivateContext);
  const [open, setOpen] = useState(false);

  const detail = stepDetail(part);
  const running = isPartRunning(part);
  const duration = running ? '' : durationOf(part);
  const failed = (part.state as { status?: string } | undefined)?.status === 'error';

  const rowClass = cn(
    // Same clipping fix as the work line: a negative RIGHT margin pushes the
    // hover background past the parent box, where an overflow-hidden ancestor
    // shears it off.
    'group/step -ml-1.5 flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm py-1 pr-2 pl-1.5',
    'text-left text-xs transition-colors select-none',
    failed
      ? 'text-kortix-red/80 hover:text-kortix-red hover:bg-kortix-red/5'
      : 'text-muted-foreground/70 hover:text-foreground hover:bg-muted/50',
  );

  const body = (
    <>
      {/* Concrete, not summarised. A collapsed run says "Ran 11 commands";
          opening it must show WHICH eleven, or the reader cannot find the one
          they want. Mono for the argument, matching the pre-refactor
          transcript. */}
      {detail.shell && (
        <span className="text-muted-foreground/50 shrink-0 font-mono select-none">$</span>
      )}
      {detail.verb && detail.mono && <span className="shrink-0">{detail.verb}</span>}
      <span
        className={cn('min-w-0 flex-1 truncate', detail.mono && 'font-mono')}
        title={detail.mono || undefined}
      >
        {detail.mono || detail.verb}
      </span>
      {duration && (
        <span className="text-muted-foreground/40 shrink-0 font-mono tabular-nums">{duration}</span>
      )}
      {running && <Loading variant="spokes" className="size-3 shrink-0" />}
    </>
  );

  // Navigating case — a real button, so Enter/Space and the focus ring come free.
  if (onActivate && !disableNavigation) {
    return (
      <button type="button" onClick={() => onActivate(part.callID)} className={rowClass}>
        {body}
        <PanelRight
          className={cn(
            'size-3 shrink-0 opacity-0 transition-opacity group-hover/step:opacity-100',
            'text-muted-foreground/40',
          )}
        />
      </button>
    );
  }

  // No panel to navigate to — expand the real tool output in place instead.
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className={rowClass}>
          {body}
          <ChevronRight
            className={cn(
              'text-muted-foreground/40 size-3 shrink-0 transition-transform',
              open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover/step:opacity-100',
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/40 my-1 ml-1 border-l pl-3">
          <ToolPartRenderer part={part} sessionId={sessionId} disableNavigation />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
