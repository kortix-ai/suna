'use client';

import type { UiTranslator } from '@/i18n/translator';
import { useTranslations } from '@/i18n/use-translations';
/**
 * The triggers list: schedules, app events and webhooks in one table.
 *
 * A row is a leading tile (the app's logo, a clock, the webhook mark), the name
 * with a status badge only when the trigger is not live, and a "When" cell of
 * exactly two lines: what starts it, then where it comes from. An error never
 * adds a line: its text is a hint on the badge and fills the callout in the
 * detail sheet. Columns drop out in reverse order of usefulness as the
 * viewport narrows, and the phone layout keeps the "when" line under the name.
 */

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
import { copyToClipboard } from '@/lib/utils/clipboard';
import type { ProjectTrigger } from '@kortix/sdk';
import {
  CopyIcon,
  DotsThreeIcon,
  LinkIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { Fragment, type ReactNode } from 'react';
import type { TriggerControls } from './trigger-controls';

import { describeEventSource, describeEventStatus, type EventAppIndex } from './event-trigger-copy';
import {
  describeLastRun,
  describeNextRun,
  describeWhen,
  localizedKindCopy,
  triggerBadgeState,
  triggerName,
  type TriggerKind,
} from './schedule-copy';
import { TriggerStatusBadge } from './trigger-status-badge';
import { TriggerTile } from './trigger-tile';

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
  /** The event catalog by app slug: real app names and logos. Empty while it loads or when events are off. */
  apps?: EventAppIndex;
  /** Event id -> the adapter's event name, from the catalog. */
  eventNames?: ReadonlyMap<string, string>;
  /** An agent slug as the agent picker names it. */
  agentLabel: (slug: string) => string;
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
  apps,
  eventNames,
  agentLabel,
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
      apps={apps}
      eventNames={eventNames}
      agentLabel={agentLabel}
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
  apps,
  eventNames,
  agentLabel,
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
  apps?: EventAppIndex;
  eventNames?: ReadonlyMap<string, string>;
  agentLabel: (slug: string) => string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const event = trigger.event;
  const name = triggerName(trigger);
  const when = describeWhen(trigger, eventNames);
  const lastRun = describeLastRun(
    trigger.type === 'event'
      ? (event?.last_event_at ?? trigger.last_fired_at)
      : trigger.last_fired_at,
  );
  const detail = whenDetail(trigger, apps, tI18nComplete);
  // Why a trigger is not live, for the badge's hint. A paused trigger needs no reason.
  const state = triggerBadgeState(trigger);
  const reason =
    state === 'error' || state === 'needs_connection'
      ? (event && describeEventStatus(event, tI18nComplete).detail) || trigger.last_error
      : null;

  return (
    <TableRow className="group cursor-pointer" onClick={onOpen}>
      <TableCell className="max-w-[16rem] align-middle">
        <div className="flex min-w-0 items-center gap-3">
          <TriggerTile
            trigger={trigger}
            logo={event ? (apps?.get(event.app ?? event.connector)?.logo ?? null) : null}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              {/* A real button, so the row is reachable by keyboard — a
                  click handler on the <tr> alone never is. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
                className="min-w-0 cursor-pointer truncate text-left text-sm font-medium outline-none focus-visible:underline"
              >
                {name}
              </button>
              <TriggerStatusBadge trigger={trigger} hideLive hint={reason} />
            </span>
            <span className="text-muted-foreground block truncate text-xs sm:hidden">{when}</span>
          </span>
        </div>
      </TableCell>

      <TableCell className="hidden max-w-[18rem] align-middle sm:table-cell">
        <p className="text-foreground truncate text-sm">{when}</p>
        {detail ? <p className="text-muted-foreground truncate text-xs">{detail}</p> : null}
      </TableCell>

      <TableCell className="text-muted-foreground hidden max-w-[10rem] truncate align-middle text-sm lg:table-cell">
        {agentLabel(trigger.agent)}
      </TableCell>

      <TableCell className="text-muted-foreground hidden align-middle text-sm whitespace-nowrap tabular-nums md:table-cell">
        {lastRun}
      </TableCell>

      <TableCell className="align-middle">
        <RowActions
          trigger={trigger}
          controls={controls}
          busy={running || toggling}
          active={trigger.enabled}
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

/** Line 2 of the "When" cell: where an event comes from, when a schedule runs next, which secret signs a webhook. */
function whenDetail(
  trigger: ProjectTrigger,
  apps: EventAppIndex | undefined,
  tI18nComplete: UiTranslator,
): ReactNode {
  if (trigger.type === 'event') {
    return trigger.event ? describeEventSource(trigger.event, tI18nComplete, apps) : null;
  }
  if (trigger.type === 'cron') {
    const parts = [trigger.run_at ? null : trigger.timezone, describeNextRun(trigger)];
    return parts.filter(Boolean).join(' · ') || null;
  }
  return trigger.secret_env ? (
    <span className="font-mono">{trigger.secret_env}</span>
  ) : (
    tI18nComplete.raw('textc0f06f876fa1')
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
        {controls.canUpdate &&
        kind === 'event' &&
        trigger.event?.status === 'needs_connection' &&
        onConnect ? (
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
