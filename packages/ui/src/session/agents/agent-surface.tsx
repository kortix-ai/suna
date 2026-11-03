'use client';

import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';
import type { SessionDisplayStatus } from '../actions/session-label';
import { SessionStatusMark } from '../../workspace/sidebar/session-status-mark';
import { AgentMarkGlyph, agentMarkTileClass, agentMarkVars } from '../../internal/components/agent-mark';

/**
 * The pieces every MyKortix agent surface in the chat is drawn from, so a
 * sub-agent call, a workflow run, a teammate's message and an agent's finish
 * read as one family (Paper F2, C19):
 *
 *   AgentCard   a bordered, rounded card; a button when the whole card leads somewhere
 *   FinishLine  the quiet line between two rules that marks an agent or a run ending
 *
 * Status glyphs are the session list's (`SessionStatusMark`), drawn still.
 */

const CARD = 'border-border bg-card flex w-full min-w-0 rounded-lg border text-left';

/** A bordered card. With `onClick` the whole card is one button and lightens on hover. */
export function AgentCard({
  children,
  onClick,
  label,
  className,
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  /** The button's accessible name, when the card is one. */
  label?: string;
  className?: string;
  testId?: string;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        onClick={onClick}
        className={cn(CARD, 'hover:bg-muted/40 cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-sm transition-colors', className)}
      >
        {children}
      </button>
    );
  }
  return (
    <div data-testid={testId} className={cn(CARD, 'flex-col overflow-hidden text-sm', className)}>
      {children}
    </div>
  );
}

/** One status glyph at 16px in a fixed slot, so rows keep one lane for it. */
export function AgentGlyph({ status }: { status: SessionDisplayStatus }) {
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
      <SessionStatusMark status={status} waitingOn="answer" />
    </span>
  );
}

/**
 * The end of an agent's or a run's work, as an event in the reply above it, not
 * a new message: `✓ Research finished · View run`, centred between two rules.
 */
export function FinishLine({
  status,
  children,
  tone = 'default',
}: {
  status: SessionDisplayStatus;
  /** The words and the actions, in reading order. */
  children: ReactNode;
  tone?: 'default' | 'failed';
}) {
  return (
    <div data-testid="finish-line" className="flex min-w-0 items-center gap-2.5 text-xs">
      <span aria-hidden className="bg-border h-px min-w-6 flex-1" />
      <span
        className={cn(
          'flex min-w-0 shrink items-center gap-1.5',
          tone === 'failed' ? 'text-kortix-red' : 'text-muted-foreground',
        )}
      >
        <span className="flex shrink-0 [&>svg]:size-3.5">
          <SessionStatusMark status={status} waitingOn="answer" />
        </span>
        {children}
      </span>
      <span aria-hidden className="bg-border h-px min-w-6 flex-1" />
    </div>
  );
}

/** A text action inside a finish line or a card header: underlined, in ink. */
export function InlineAction({ children, onClick, label }: { children: ReactNode; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="text-foreground shrink-0 cursor-pointer underline underline-offset-2"
    >
      {children}
    </button>
  );
}

/** A team task's status as a session-list glyph: open is a grey ring, in progress the working arc, done the done ring. */
export function taskGlyphStatus(status: 'pending' | 'in_progress' | 'completed'): SessionDisplayStatus {
  return status === 'completed' ? 'done' : status === 'in_progress' ? 'running' : 'starting';
}

/** A glyph at 14px in a 14px slot, for the 12px rows of tool results and panels. */
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

/** Who owns a task or sent a message: the agent's face and its handle. */
export function AgentHandle({ handle }: { handle: string }) {
  return (
    <span className="text-muted-foreground flex max-w-36 min-w-0 shrink-0 items-center gap-1.5">
      <span
        aria-hidden
        style={agentMarkVars(handle)}
        className={cn('flex size-4 shrink-0 items-center justify-center rounded-sm bg-(--mark-tile)', agentMarkTileClass(handle))}
      >
        <AgentMarkGlyph slug={handle} size={14} />
      </span>
      <span className="min-w-0 truncate">@{handle}</span>
    </span>
  );
}
