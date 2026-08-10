'use client';

import { sessionSource, type SessionSourceKind } from '@/components/workspaces/session-label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { TypedTitle } from '@/components/ui/typed-title';
import { Slack } from '@/features/icon/icons/slack';
import { Telegram } from '@/features/icon/icons/telegram';
import {
  getSessionDisplayTitle,
  shortRelative,
} from '@/features/workspace/workspace-sidebar/workspace-session-list-helpers';
import { cn } from '@/lib/utils';
import type { WorkspaceSession, WorkspaceSessionStatus } from '@kortix/sdk';
import {
  ArrowCounterClockwiseIcon,
  CalendarDotsIcon,
  ChatTeardropTextIcon,
  DotsThreeIcon,
  EnvelopeIcon,
  PencilSimpleIcon,
  ShareNetworkIcon,
  SquareIcon,
  TrashIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';
import { useState, type ComponentType, type ReactNode } from 'react';

import { sessionAccessMeta } from './workspace-sessions-helpers';

/** Fixed slot shared by relative time and the ⋯ trigger — same overlay swap as
 *  the sidebar session list so the row never reflows on hover. */
const SESSION_RELATIVE_TIME_CLASS =
  'text-muted-foreground block w-10 min-w-10 max-w-10 shrink-0 truncate text-right text-xs tabular-nums';

const SOURCE_ICONS: Record<SessionSourceKind, ComponentType<{ className?: string }>> = {
  chat: ChatTeardropTextIcon,
  slack: Slack,
  telegram: Telegram,
  email: EnvelopeIcon,
  schedule: CalendarDotsIcon,
  webhook: WebhooksLogoIcon,
};

interface StatusTile {
  label: string;
  tile: string;
  icon: string;
}

/** Resting / idle — secondary surface, muted icon. Matches design-system idle. */
const SECONDARY_TILE: Pick<StatusTile, 'tile' | 'icon'> = {
  tile: 'bg-secondary',
  icon: 'text-muted-foreground',
};

/**
 * Status colour on the source-icon tile. Deleted wins over lifecycle status.
 * Palette follows kortix design-system status tokens.
 */
function sessionStatusTile(
  status: WorkspaceSessionStatus,
  options: { deleted: boolean; metadataOnly: boolean },
): StatusTile {
  if (options.deleted) {
    return { label: 'Deleted', tile: 'bg-kortix-red/15', icon: 'text-kortix-red' };
  }
  if (options.metadataOnly) {
    return { label: 'Metadata only', ...SECONDARY_TILE };
  }

  switch (status) {
    case 'running':
      return { label: 'Running', tile: 'bg-kortix-green/15', icon: 'text-kortix-green' };
    case 'queued':
      return { label: 'Queued', tile: 'bg-kortix-yellow/15', icon: 'text-kortix-yellow' };
    case 'branching':
      return { label: 'Branching', tile: 'bg-kortix-yellow/15', icon: 'text-kortix-yellow' };
    case 'provisioning':
      return { label: 'Provisioning', tile: 'bg-kortix-yellow/15', icon: 'text-kortix-yellow' };
    case 'failed':
      return { label: 'Failed', tile: 'bg-kortix-red/15', icon: 'text-kortix-red' };
    case 'completed':
      return { label: 'Completed', ...SECONDARY_TILE };
    case 'stopped':
      return { label: 'Stopped', ...SECONDARY_TILE };
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled session status: ${String(_exhaustive)}`);
    }
  }
}

export interface SessionRowActions {
  onRename: (sessionId: string, currentName: string) => void;
  onShare: (session: WorkspaceSession) => void;
  onDelete: (sessionId: string, label: string) => void;
  onRestart: (sessionId: string, label: string) => void;
  onStop: (sessionId: string, label: string) => void;
}

export interface SessionRowProps {
  session: WorkspaceSession;
  /** Preformatted last-activity stamp. Formatting stays in the container so
   *  every row shares one `date-fns` pass instead of one per row. */
  time: { relative: string; exact: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (sessionId: string) => void;
  restarting: boolean;
  stopping: boolean;
  actions: SessionRowActions;
  /** Detail panel — the container renders it only while expanded. */
  children: ReactNode;
}

export function SessionRow({
  session,
  time,
  open,
  onOpenChange,
  selectMode,
  selected,
  onToggleSelect,
  restarting,
  stopping,
  actions,
  children,
}: SessionRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const title = getSessionDisplayTitle(session);
  const source = sessionSource(session);
  const SourceIcon = SOURCE_ICONS[source.kind];
  const access = sessionAccessMeta(session);
  const isDeleted = Boolean(session.deleted_at);
  const canManageSharing = session.can_manage_sharing !== false && !isDeleted;
  const hasLifecycleActions = access.canOpen && !isDeleted;
  const hasActions = canManageSharing || hasLifecycleActions;
  const relativeLabel = time.relative ? shortRelative(time.relative) : '';
  const statusTile = sessionStatusTile(session.status, {
    deleted: isDeleted,
    metadataOnly: session.can_access === false,
  });

  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const identity = (
    <>
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-sm',
          statusTile.tile,
        )}
        title={statusTile.label}
        aria-label={statusTile.label}
      >
        <SourceIcon className={cn('size-4', statusTile.icon)} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">
        {/* Types itself in when the name changes — a session created moments
            ago reads "New session" until the agent names it, and this is what
            shows that the name was written rather than swapped. Plain text at
            rest, so the row is unchanged (and still ellipsises) until then. */}
        <TypedTitle text={title} />
        {source.triggerSlug ? (
          <span className="text-muted-foreground"> · {source.triggerSlug}</span>
        ) : null}
      </span>
    </>
  );

  if (selectMode) {
    return (
      // A label, not a button: the row wraps a real Checkbox, and nesting a
      // button (Radix renders one) inside a button is invalid.
      <label
        className={cn(
          'hover:bg-muted/40 flex h-11 w-full cursor-pointer items-center gap-3 rounded-md px-3 text-left',
          'transition-colors duration-150',
          'has-disabled:pointer-events-none has-disabled:opacity-50',
          selected && 'bg-primary/[0.06]',
        )}
      >
        <Checkbox
          checked={selected}
          disabled={isDeleted}
          onCheckedChange={() => onToggleSelect(session.session_id)}
          aria-label={title}
          // The stock checked state is `bg-kortix-blue`, the exact accent this
          // redesign removes; everything else about the control is inherited.
          className="data-[state=checked]:border-foreground data-[state=checked]:bg-foreground"
        />
        {identity}
        {relativeLabel ? (
          <time
            className={SESSION_RELATIVE_TIME_CLASS}
            dateTime={time.exact}
            title={`Last activity: ${time.exact}`}
          >
            {relativeLabel}
          </time>
        ) : null}
      </label>
    );
  }

  return (
    <Disclosure
      open={open}
      onOpenChange={onOpenChange}
      variant="outline"
      className="group/session bg-popover overflow-hidden"
    >
      <DisclosureTrigger variant="outline">
        {/* A div, not a button: DisclosureTrigger clones this child and applies
            role="button" + tabIndex itself. Nesting a real button here would
            produce button-in-button. */}
        <div
          aria-label={`${open ? 'Hide' : 'Show'} details for ${title}`}
          className="hover:bg-muted/40 group/row flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors duration-150"
        >
          {identity}

          {/* Same fixed slot as the sidebar: relative time fades out on hover /
              open menu; the ⋯ trigger fades in over the same w-10. */}
          <div className="relative w-10 min-w-10 shrink-0">
            {relativeLabel ? (
              <time
                className={cn(
                  SESSION_RELATIVE_TIME_CLASS,
                  'pr-1.5 transition-opacity duration-150',
                  hasActions &&
                    cn(
                      'opacity-100 group-hover/row:opacity-0 group-has-data-[state=open]/row:opacity-0',
                      // Touch has no hover — cede the slot to the always-visible ⋯.
                      '[@media(hover:none)]:opacity-0',
                    ),
                )}
                dateTime={time.exact}
                title={`Last activity: ${time.exact}`}
                aria-label={`Last activity: ${relativeLabel}`}
              >
                {relativeLabel}
              </time>
            ) : null}

            {hasActions ? (
              // Stops the row's toggle from firing when the menu is used.
              <span
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${title}`}
                      className={cn(
                        'absolute top-1/2 right-0.5 -translate-y-1/2 transition-opacity duration-150',
                        'focus:ring-0 focus-visible:ring-0 active:scale-[0.96]',
                        relativeLabel
                          ? cn(
                              'pointer-events-none opacity-0',
                              'group-hover/row:pointer-events-auto group-hover/row:opacity-100',
                              'data-[state=open]:pointer-events-auto data-[state=open]:opacity-100',
                              // Touch has no hover — keep the only path visible.
                              '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
                            )
                          : 'opacity-100',
                      )}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <DotsThreeIcon className="size-3.5 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    {hasLifecycleActions ? (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onSelect={() =>
                          deferAfterClose(() => actions.onRename(session.session_id, title))
                        }
                      >
                        <PencilSimpleIcon />
                        Rename
                      </DropdownMenuItem>
                    ) : null}
                    {canManageSharing ? (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onSelect={() => deferAfterClose(() => actions.onShare(session))}
                      >
                        <ShareNetworkIcon />
                        Share
                      </DropdownMenuItem>
                    ) : null}
                    {hasLifecycleActions ? (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={restarting}
                        onSelect={() =>
                          deferAfterClose(() => actions.onRestart(session.session_id, title))
                        }
                      >
                        {restarting ? (
                          <Loading className="size-4 shrink-0" />
                        ) : (
                          <ArrowCounterClockwiseIcon />
                        )}
                        Restart
                      </DropdownMenuItem>
                    ) : null}
                    {session.status === 'running' && hasLifecycleActions ? (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={stopping}
                        onSelect={() =>
                          deferAfterClose(() => actions.onStop(session.session_id, title))
                        }
                      >
                        {stopping ? <Loading className="size-4 shrink-0" /> : <SquareIcon />}
                        Stop
                      </DropdownMenuItem>
                    ) : null}
                    {hasLifecycleActions ? (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        variant="destructive"
                        onSelect={() =>
                          deferAfterClose(() => actions.onDelete(session.session_id, title))
                        }
                      >
                        <TrashIcon />
                        Delete
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            ) : null}
          </div>
        </div>
      </DisclosureTrigger>

      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        {children}
      </DisclosureContent>
    </Disclosure>
  );
}
