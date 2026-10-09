'use client';

import { useTranslations } from '@/i18n/use-translations';
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
import { Fragment, type ReactNode } from 'react';
import type { TriggerControls } from './trigger-controls';
import {
  CopyIcon,
  DotsThreeIcon,
  LightningIcon,
  LinkIcon,
  PauseIcon,
  PlayIcon,
  TimerIcon,
  TrashIcon,
  WarningCircleIcon,
  WebhooksLogoIcon,
} from '@phosphor-icons/react';

import { describeEventSource, describeEventStatus } from './event-trigger-copy';
import {
  describeLastRun,
  describeSecurity,
  describeWhen,
  localizedKindCopy,
  triggerName,
  triggerStatus,
  type TriggerKind,
} from './schedule-copy';

async function copyWebhookAddress(
  url: string,
  copiedMessage: string,
  failedMessage: string,
): Promise<void> {
  const ok = await copyToClipboard(url);
  if (ok) successToast(copiedMessage);
  else errorToast(failedMessage);
}

export interface ScheduleTableProps {
  triggers: ProjectTrigger[];
  controls: TriggerControls;
  /** Slug of the row whose run is in flight, if any. */
  runningSlug: string | null;
  /** Slug of the row whose pause/resume is in flight, if any. */
  togglingSlug: string | null;
  onOpen: (trigger: ProjectTrigger) => void;
  onRun: (trigger: ProjectTrigger) => void;
  onToggle: (trigger: ProjectTrigger) => void;
  onDelete: (trigger: ProjectTrigger) => void;
  /** Opens the connect flow for an app-event trigger that needs an account. */
  onConnect?: (trigger: ProjectTrigger) => void;
  /** Rows under a heading row each, e.g. the App events view by app. Replaces `triggers`' order. */
  groups?: { key: string; heading: ReactNode; triggers: ProjectTrigger[] }[];
}

/** A mixed list of schedules and webhooks — the type comes off each row's
 *  own `trigger.type`, never a table-wide prop, so the two kinds can share
 *  one table. */
export function ScheduleTable({
  triggers,
  controls,
  runningSlug,
  togglingSlug,
  onOpen,
  onRun,
  onToggle,
  onDelete,
  onConnect,
  groups,
}: ScheduleTableProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const renderRow = (trigger: ProjectTrigger) => (
    <ScheduleTableRow
      key={trigger.slug}
      trigger={trigger}
      controls={controls}
      running={runningSlug === trigger.slug}
      toggling={togglingSlug === trigger.slug}
      onOpen={() => onOpen(trigger)}
      onRun={() => onRun(trigger)}
      onToggle={() => onToggle(trigger)}
      onDelete={() => onDelete(trigger)}
      onConnect={onConnect ? () => onConnect(trigger) : undefined}
    />
  );
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{tI18nComplete.raw('textdcd1d5223f73')}</TableHead>
          <TableHead className="hidden sm:table-cell">
            {tI18nComplete.raw('textcf9c7aa24a26')}
          </TableHead>
          <TableHead className="hidden lg:table-cell">
            {tI18nComplete.raw('text11b39c93777e')}
          </TableHead>
          <TableHead className="hidden md:table-cell">
            {tI18nComplete.raw('text512a48218ba2')}
          </TableHead>
          <TableHead className="w-[52px]">
            <span className="sr-only">{tI18nComplete.raw('textff8059dc6752')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups
          ? groups.map((group) => (
              <Fragment key={group.key}>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={5} className="py-2">
                    {group.heading}
                  </TableCell>
                </TableRow>
                {group.triggers.map(renderRow)}
              </Fragment>
            ))
          : triggers.map(renderRow)}
      </TableBody>
    </Table>
  );
}

function ScheduleTableRow({
  trigger,
  controls,
  running,
  toggling,
  onOpen,
  onRun,
  onToggle,
  onDelete,
  onConnect,
}: {
  trigger: ProjectTrigger;
  controls: TriggerControls;
  running: boolean;
  toggling: boolean;
  onOpen: () => void;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onConnect?: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tTriggers = useTranslations('triggers');
  const kind = trigger.type;
  const name = triggerName(trigger);
  const status = triggerStatus(trigger.enabled, tI18nComplete);
  const when = describeWhen(trigger);
  const security = describeSecurity(trigger, tI18nComplete);
  const KindIcon =
    kind === 'cron' ? TimerIcon : kind === 'event' ? LightningIcon : WebhooksLogoIcon;
  // A paused trigger holds no subscription: its tile already says Paused.
  const eventStatus = trigger.event && trigger.enabled ? describeEventStatus(trigger.event, tI18nComplete) : null;
  const lastRun = describeLastRun(
    kind === 'event'
      ? (trigger.event?.last_event_at ?? trigger.last_fired_at)
      : trigger.last_fired_at,
  );
  // A run that failed outranks Active/Paused on the tile: it is the one
  // state the owner has to act on.
  const failed = trigger.last_status === 'failed';
  const StatusIcon = failed ? WarningCircleIcon : status.active ? KindIcon : PauseIcon;

  return (
    <TableRow className="group cursor-pointer" onClick={onOpen}>
      <TableCell className="max-w-[15rem] align-middle">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-sm',
              failed ? 'bg-kortix-red/15' : status.tileClassName,
            )}
            aria-hidden="true"
          >
            <StatusIcon
              weight="fill"
              className={cn('size-4 shrink-0', failed ? 'text-kortix-red' : status.iconClassName)}
            />
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
            {kind === 'event' && trigger.event ? (
              <span className="text-muted-foreground block truncate text-xs sm:hidden">
                {describeEventSource(trigger.event, tI18nComplete)}
              </span>
            ) : null}
            {failed ? (
              <span className="text-muted-foreground hidden text-xs sm:block">
                {tTriggers('runFailed.label')}
              </span>
            ) : !status.active ? (
              <span className="text-muted-foreground hidden text-xs sm:block">
                {tI18nComplete.raw('texte159b06187d3')}
              </span>
            ) : null}
          </span>
        </div>
      </TableCell>

      <TableCell className="hidden max-w-[14rem] align-middle sm:table-cell">
        <div className="min-w-0 space-y-1">
          <p className="text-foreground truncate text-sm">{when}</p>
          {kind === 'event' && trigger.event ? (
            <p className="text-muted-foreground truncate text-xs">
              {describeEventSource(trigger.event, tI18nComplete)}
            </p>
          ) : null}
          {kind === 'cron' && !trigger.run_at ? (
            <p className="text-muted-foreground truncate text-xs">{trigger.timezone}</p>
          ) : kind === 'webhook' ? (
            <Badge variant={security.signed ? 'kortix' : 'warning'} size="sm">
              {security.label}
            </Badge>
          ) : eventStatus ? (
            <>
              <Badge variant={eventStatus.variant} size="sm">
                {eventStatus.label}
              </Badge>
              {eventStatus.label === 'Error' && eventStatus.detail ? (
                <p className="text-muted-foreground truncate text-xs">{eventStatus.detail}</p>
              ) : null}
            </>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="text-muted-foreground hidden max-w-[10rem] truncate align-middle text-sm lg:table-cell">
        {trigger.agent}
      </TableCell>

      <TableCell className="text-muted-foreground hidden align-middle text-sm whitespace-nowrap tabular-nums md:table-cell">
        {lastRun}
      </TableCell>

      <TableCell className="align-middle">
        <RowActions
          trigger={trigger}
          controls={controls}
          busy={running || toggling}
          active={status.active}
          onOpen={onOpen}
          onRun={onRun}
          onToggle={onToggle}
          onDelete={onDelete}
          onConnect={onConnect}
        />
      </TableCell>
    </TableRow>
  );
}

function RowActions({
  trigger,
  controls,
  busy,
  active,
  onOpen,
  onRun,
  onToggle,
  onDelete,
  onConnect,
}: {
  trigger: ProjectTrigger;
  controls: TriggerControls;
  busy: boolean;
  active: boolean;
  onOpen: () => void;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onConnect?: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Safe: `ScheduleView` filters every list to `isTriggerKind` before it
  // reaches this table.
  const kind = trigger.type as TriggerKind;
  const noun = localizedKindCopy(tI18nComplete)[kind].noun;
  const webhookUrl = trigger.webhook_url ?? '';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label={tI18nComplete('text33da220b1a34', { value0: triggerName(trigger) })}
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
        <DropdownMenuItem onClick={onOpen}>
          {tI18nComplete.raw('texted077f3d8125')} {noun}
        </DropdownMenuItem>
        {kind === 'webhook' && webhookUrl ? (
          <DropdownMenuItem
            onClick={() =>
              void copyWebhookAddress(
                webhookUrl,
                tI18nComplete.raw('texta26175817712'),
                tI18nComplete.raw('text07ef6afe47b4'),
              )
            }
          >
            <CopyIcon className="size-3.5 shrink-0" />
            {tI18nComplete.raw('text7c4e5224f9d4')}
          </DropdownMenuItem>
        ) : null}
        {controls.canFire || controls.canUpdate ? <DropdownMenuSeparator /> : null}
        {controls.canUpdate && kind === 'event' && trigger.event?.status === 'needs_connection' && onConnect ? (
          <DropdownMenuItem onClick={onConnect}>
            <LinkIcon className="size-3.5 shrink-0" />
            {tI18nComplete.raw('textf7d845186faa')}
          </DropdownMenuItem>
        ) : null}
        {controls.canFire ? (
          <DropdownMenuItem onClick={onRun}>
            <PlayIcon weight="fill" className="size-3.5 shrink-0" />
            {tI18nComplete.raw('text0991397702fa')}
          </DropdownMenuItem>
        ) : null}
        {controls.canUpdate ? (
          <DropdownMenuItem onClick={onToggle}>
            {active ? (
              <PauseIcon weight="fill" className="size-3.5 shrink-0" />
            ) : (
              <PlayIcon weight="fill" className="size-3.5 shrink-0" />
            )}
            {active ? 'Pause' : 'Resume'}
          </DropdownMenuItem>
        ) : null}
        {controls.canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <TrashIcon className="size-3.5 shrink-0" />
              {tI18nComplete.raw('texte2d0a54968ea')} {noun}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
