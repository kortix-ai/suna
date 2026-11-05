'use client';

import { ArrowUpRightIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useContext, useId, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { AgentMarkGlyph, agentMarkTileClass, agentMarkVars } from '../../internal/components/agent-mark';
import { cn } from '../../lib/utils';
import { SessionStatusMark } from '../list/session-status-mark';
import type { SessionDisplayStatus } from '../actions/session-label';
import { TextShimmer } from '../../primitives/text-shimmer';
import { BoundActivateContext, ToolOutcomeContext, ToolRunningContext, useToolOpen } from '../tool/shared/infrastructure-contexts';

/**
 * The parts every MyKortix agent surface in the chat is drawn from. An agent
 * call, an agent's finish, a message to or from another agent and a workflow
 * agent are all one row grammar, the grammar of every other tool row:
 *
 *   [face] Title  what it is about…                 ◔ State
 *          │ the detail, on a rail in the icon lane, when the row opens
 *
 * The face is the agent's pixel mark in the 16px icon lane. The state is the
 * session list's static glyph and a muted word: the hue is on the glyph, never
 * on the words (color.md). A row opens in place; nothing opens beside the chat.
 */

/** An agent's own handle, or the lead session's generated handle, as a pixel-mark slug. */
export function agentSlug(handle: string): string {
  return /^(mykortix|meta)-[0-9a-f]{8}$/.test(handle) ? 'mykortix' : handle;
}

/** The agent's face: its pixel mark on its tile, 16px, in the row's icon lane. */
export function AgentFace({ handle, className }: { handle: string; className?: string }) {
  const slug = agentSlug(handle);
  return (
    <span
      aria-hidden
      data-tone="agent"
      style={agentMarkVars(slug)}
      className={cn('flex size-4 shrink-0 items-center justify-center rounded-sm bg-(--mark-tile)', agentMarkTileClass(slug), className)}
    >
      <AgentMarkGlyph slug={slug} size={14} />
    </span>
  );
}

/** A session-list glyph at 14px in a 14px slot. */
export function SmallGlyph({ status, label }: { status: SessionDisplayStatus; label?: string }) {
  return (
    <>
      <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5">
        <SessionStatusMark status={status} waitingOn="answer" />
      </span>
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

/**
 * The title and subtitle of an agent row. The title is a handle or a name, so it
 * yields past `max-w-40` and the subtitle (what the agent works on) keeps its room.
 */
export function AgentTrigger({ title, subtitle }: { title: string; subtitle?: string | null }) {
  const running = useContext(ToolRunningContext);
  return (
    <>
      <span className="text-foreground max-w-40 min-w-0 shrink-0 truncate text-sm" title={title}>
        {title}
      </span>
      {subtitle &&
        (running ? (
          <TextShimmer className="min-w-0 flex-1 truncate text-sm">{subtitle}</TextShimmer>
        ) : (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm" title={subtitle}>
            {subtitle}
          </span>
        ))}
    </>
  );
}

/**
 * The right edge of an agent row: the state glyph and its word, muted. A row
 * that opens ends in a caret, so it reads as one before anyone clicks it.
 */
export function AgentStatus({
  status,
  label,
  time,
  opens = false,
}: {
  status?: SessionDisplayStatus;
  label: string;
  time?: string;
  /** The row has a body to open: draw the caret. */
  opens?: boolean;
}) {
  const open = useToolOpen();
  return (
    <span data-agent-status={status} className="text-muted-foreground flex shrink-0 items-center gap-1.5 pl-3 text-xs">
      {status && <SmallGlyph status={status} />}
      <span className="whitespace-nowrap">{label}</span>
      {time && <span className="tabular-nums">{time}</span>}
      {/* The caret's slot is always there, so every row's state word ends on one edge. */}
      <CaretRightIcon
        aria-hidden
        data-slot={opens ? 'agent-row-caret' : undefined}
        className={cn(
          'size-3 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none',
          !opens && 'invisible',
          open && 'rotate-90',
        )}
      />
    </span>
  );
}

/**
 * An agent row's detail, when it opens: on a rail in the icon lane (the centre
 * of the 16px face), its text on the title's left edge, at the chat's reading size.
 */
export function AgentRowBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('border-border ml-2 flex min-w-0 flex-col gap-2.5 border-l py-1 pl-3 text-sm', className)}>
      {children}
    </div>
  );
}

/**
 * The agent rows own their disclosure: a click opens the row in place. The chat
 * would otherwise route a tool row's click into the side panel, and an errored
 * call would trade the agent's face for the warning triangle; the state word says it.
 */
export function AgentRowScope({ children }: { children: ReactNode }) {
  return (
    <BoundActivateContext.Provider value={null}>
      <ToolOutcomeContext.Provider value="ok">{children}</ToolOutcomeContext.Provider>
    </BoundActivateContext.Provider>
  );
}

/** "Open" on an agent row's body: the agent's own conversation, in the agent dialog. */
export function OpenAgentButton({ onClick, label, children }: { onClick: () => void; label: string; children?: ReactNode }) {
  const t = useTranslations('tools.agent');
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="text-foreground hover:bg-muted/60 -ml-1.5 flex h-7 w-fit cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs transition-colors"
    >
      {children ?? t('open')}
      <ArrowUpRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
    </button>
  );
}

/**
 * Why an agent did not finish: one sentence in ink, and the raw text the
 * platform or provider gave behind "Details", in mono (layout.md, errors).
 */
export function AgentFailure({ sentence, raw }: { sentence: string; raw?: string | null }) {
  const t = useTranslations('multiAgent.notice');
  const [open, setOpen] = useState(false);
  const id = useId();
  const detail = raw?.trim();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-foreground">{sentence}</p>
      {detail && detail !== sentence && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
            className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-xs"
          >
            <CaretRightIcon aria-hidden className={cn('size-3 transition-transform duration-(--duration-fast) motion-reduce:transition-none', open && 'rotate-90')} />
            {t('details')}
          </button>
          {open && (
            <pre id={id} className="text-muted-foreground font-mono text-xs whitespace-pre-wrap wrap-break-word">
              {detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** A team task's status as a session-list glyph: open is a grey ring, in progress the working arc, done the done ring. */
export function taskGlyphStatus(status: 'pending' | 'in_progress' | 'completed'): SessionDisplayStatus {
  return status === 'completed' ? 'done' : status === 'in_progress' ? 'running' : 'starting';
}

/** Who owns a task or sent a message: the agent's face and its handle. */
export function AgentHandle({ handle }: { handle: string }) {
  return (
    <span className="text-muted-foreground flex max-w-36 min-w-0 shrink-0 items-center gap-1.5">
      <AgentFace handle={handle} />
      <span className="min-w-0 truncate">@{handle}</span>
    </span>
  );
}
