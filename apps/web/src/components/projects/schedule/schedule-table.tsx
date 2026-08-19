'use client';

/**
 * The schedules / webhooks list.
 *
 * **What changed and why.** The old table led with a bare icon column, then
 * showed the trigger's 8-character slug under its name, an UPPERCASED agent,
 * a "Signing" column reading "Signed via WEBHOOK_FOO_SECRET", and a "Last
 * fired" column — five columns of wire vocabulary, no row actions, and no
 * responsive behaviour, so on a phone it became a sideways scroll of
 * identifiers. Now: the status tile leads the name cell (one column saved),
 * every value is a sentence, and the columns drop out in reverse order of
 * usefulness as the viewport narrows, with the schedule folded under the name
 * so the phone layout still answers "when does this run?".
 *
 * Row actions live here too. Pausing a schedule used to require opening the
 * panel, reading it, and finding a button — for the single most common thing
 * anyone does on this screen.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/utils/clipboard';
import type { ProjectTrigger } from '@kortix/sdk';
import {
  CopyIcon,
  DotsThreeIcon,
  PauseIcon,
  PlayIcon,
  TimerIcon,
  TrashIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';

import {
  KIND_COPY,
  type TriggerKind,
  describeLastRun,
  describeSecurity,
  describeWhen,
  triggerName,
  triggerStatus,
} from './schedule-copy';

async function copyWebhookAddress(url: string): Promise<void> {
  const ok = await copyToClipboard(url);
  if (ok) successToast('Address copied');
  else errorToast('Copy failed — open the webhook and copy it from there');
}

export interface ScheduleTableProps {
  triggers: ProjectTrigger[];
  canWrite: boolean;
  /** Slug of the row whose run is in flight, if any. */
  runningSlug: string | null;
  /** Slug of the row whose pause/resume is in flight, if any. */
  togglingSlug: string | null;
  onOpen: (trigger: ProjectTrigger) => void;
  onRun: (trigger: ProjectTrigger) => void;
  onToggle: (trigger: ProjectTrigger) => void;
  onDelete: (trigger: ProjectTrigger) => void;
}

/** A mixed list of schedules and webhooks — the type comes off each row's
 *  own `trigger.type`, never a table-wide prop, so the two kinds can share
 *  one table. */
export function ScheduleTable({
  triggers,
  canWrite,
  runningSlug,
  togglingSlug,
  onOpen,
  onRun,
  onToggle,
  onDelete,
}: ScheduleTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Name</TableHead>
          <TableHead className="hidden sm:table-cell">When</TableHead>
          <TableHead className="hidden lg:table-cell">Agent</TableHead>
          <TableHead className="hidden md:table-cell">Last run</TableHead>
          <TableHead className="w-[52px]">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {triggers.map((trigger) => (
          <ScheduleTableRow
            key={trigger.slug}
            trigger={trigger}
            canWrite={canWrite}
            running={runningSlug === trigger.slug}
            toggling={togglingSlug === trigger.slug}
            onOpen={() => onOpen(trigger)}
            onRun={() => onRun(trigger)}
            onToggle={() => onToggle(trigger)}
            onDelete={() => onDelete(trigger)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function ScheduleTableRow({
  trigger,
  canWrite,
  running,
  toggling,
  onOpen,
  onRun,
  onToggle,
  onDelete,
}: {
  trigger: ProjectTrigger;
  canWrite: boolean;
  running: boolean;
  toggling: boolean;
  onOpen: () => void;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const kind = trigger.type;
  const name = triggerName(trigger);
  const status = triggerStatus(trigger.enabled);
  const when = describeWhen(trigger);
  const security = describeSecurity(trigger);
  const KindIcon = kind === 'cron' ? TimerIcon : WebhooksLogoIcon;
  const StatusIcon = status.active ? KindIcon : PauseIcon;

  return (
    <TableRow className="group cursor-pointer" onClick={onOpen}>
      <TableCell className="max-w-[15rem] align-middle">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-sm',
              status.tileClassName,
            )}
            aria-hidden="true"
          >
            <StatusIcon weight="fill" className={cn('size-4 shrink-0', status.iconClassName)} />
          </span>
          <span className="min-w-0 flex-1">
            {/* A real button, so the row is reachable by keyboard — a
                click handler on the <tr> alone never is. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              className="block max-w-full cursor-pointer truncate text-left text-sm font-medium outline-none focus-visible:underline"
            >
              {name}
            </button>
            <span className="text-muted-foreground block truncate text-xs sm:hidden">{when}</span>
            {!status.active && (
              <span className="text-muted-foreground hidden text-xs sm:block">Paused</span>
            )}
          </span>
        </div>
      </TableCell>

      <TableCell className="hidden max-w-[14rem] align-middle sm:table-cell">
        <div className="min-w-0 space-y-1">
          <p className="text-foreground truncate text-sm">{when}</p>
          {kind === 'cron' && !trigger.run_at ? (
            <p className="text-muted-foreground truncate text-xs">{trigger.timezone}</p>
          ) : kind === 'webhook' ? (
            <Badge variant={security.signed ? 'kortix' : 'warning'} size="sm">
              {security.label}
            </Badge>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="text-muted-foreground hidden max-w-[10rem] truncate align-middle text-sm lg:table-cell">
        {trigger.agent}
      </TableCell>

      <TableCell className="text-muted-foreground hidden align-middle text-sm whitespace-nowrap tabular-nums md:table-cell">
        {describeLastRun(trigger.last_fired_at)}
      </TableCell>

      <TableCell className="align-middle">
        <RowActions
          trigger={trigger}
          canWrite={canWrite}
          busy={running || toggling}
          active={status.active}
          onOpen={onOpen}
          onRun={onRun}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      </TableCell>
    </TableRow>
  );
}

function RowActions({
  trigger,
  canWrite,
  busy,
  active,
  onOpen,
  onRun,
  onToggle,
  onDelete,
}: {
  trigger: ProjectTrigger;
  canWrite: boolean;
  busy: boolean;
  active: boolean;
  onOpen: () => void;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  // Safe: `ScheduleView` filters every list to `isTriggerKind` before it
  // reaches this table.
  const kind = trigger.type as TriggerKind;
  const noun = KIND_COPY[kind].noun;
  const webhookUrl = trigger.webhook_url ?? '';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Actions for ${triggerName(trigger)}`}
          onClick={(e) => e.stopPropagation()}
        >
          {busy ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <DotsThreeIcon className="size-4 shrink-0" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={onOpen}>Open {noun}</DropdownMenuItem>
        {kind === 'webhook' && webhookUrl ? (
          <DropdownMenuItem onClick={() => void copyWebhookAddress(webhookUrl)}>
            <CopyIcon className="size-3.5 shrink-0" />
            Copy address
          </DropdownMenuItem>
        ) : null}
        {canWrite ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onRun}>
              <PlayIcon weight="fill" className="size-3.5 shrink-0" />
              Run now
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onToggle}>
              {active ? (
                <PauseIcon weight="fill" className="size-3.5 shrink-0" />
              ) : (
                <PlayIcon weight="fill" className="size-3.5 shrink-0" />
              )}
              {active ? 'Pause' : 'Resume'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <TrashIcon className="size-3.5 shrink-0" />
              Delete {noun}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
