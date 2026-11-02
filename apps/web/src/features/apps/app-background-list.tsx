'use client';

import { Badge } from '@kortix/ui/badge';
import { Checkbox } from '@kortix/ui/checkbox';
import { CountBadge } from '@kortix/ui/count-badge';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@kortix/ui/disclosure';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { appStatus, appTriggers, backgroundSummary } from '@kortix/ui/apps';
import { cn } from '@kortix/ui';
import { type App, type ProjectTrigger } from '@kortix/sdk';
import { CaretRightIcon } from '@phosphor-icons/react';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { UiTranslator } from '@/i18n/translator';
import type { AppSelect } from './apps-view';

/**
 * The Apps that run rather than get opened: a poller, a bot, a backend.
 *
 * They have nothing to look at, so they get no thumbnail. One line says how
 * many there are and what state they are in; it folds open into a dense list
 * where each row answers what a person checks on a background App: is it up,
 * what is it, how does it run, what calls it, when did it last do anything.
 */
export function BackgroundApps({
  apps,
  triggers,
  open,
  onOpenChange,
  onOpen,
  select,
}: {
  apps: App[];
  triggers: ProjectTrigger[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (appId: string) => void;
  /** Agent scope: each row's grant checkbox (`AppsView`). */
  select?: (app: App) => AppSelect | undefined;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const counts = backgroundSummary(apps);
  const summary = [
    counts.running ? t('textdbf09e33067b', { value0: counts.running }) : null,
    counts.asleep ? t('text09ca25aa9ecf', { value0: counts.asleep }) : null,
    counts.undeployed ? t('text7850d9d304e8', { value0: counts.undeployed }) : null,
    counts.external ? t('texta06ef89024c7', { value0: counts.external }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <Disclosure open={open} onOpenChange={onOpenChange} className="space-y-3">
      <DisclosureTrigger>
        <button
          type="button"
          className="hover:text-foreground flex w-full items-center gap-2.5 rounded-md py-1 text-left focus-visible:outline-none"
        >
          <CaretRightIcon
            aria-hidden
            className={cn('text-muted-foreground duration-normal size-3 shrink-0 transition-transform ease-out', open && 'rotate-90')}
          />
          <span className="text-foreground text-sm font-medium">{t.raw('textea2b8a878841')}</span>
          <CountBadge count={apps.length} />
          <span className="text-muted-foreground ml-auto truncate pl-3 text-xs tabular-nums">{summary}</span>
        </button>
      </DisclosureTrigger>
      <DisclosureContent>
        <ul className="space-y-1.5 pb-1">
          {apps.map((app) => (
            <BackgroundRow key={app.app_id} app={app} triggers={triggers} onOpen={() => onOpen(app.app_id)} select={select?.(app)} />
          ))}
        </ul>
      </DisclosureContent>
    </Disclosure>
  );
}

/** "Server · Sleeps when idle · Called by poll-inbox": what the App is and what wakes it. */
export function backgroundMeta(app: App, triggers: ProjectTrigger[], t: UiTranslator): string {
  const caller = appTriggers(app, triggers).calledBy[0];
  const kind = app.external_url
    ? [t.raw('text68c114ea9c8c')]
    : !app.active_deployment_id
      ? [t.raw('text94ecd43f8b2b')]
      : app.hosting_type === 'static'
        ? [t.raw('text903b49a91e18')]
        : [t.raw('textaef7de28d529'), app.always_on ? t.raw('text660bf36b1338') : t.raw('text6aa00f0b3e36')];
  return [...kind, caller ? t('textd6d136eb7406', { value0: caller.name || caller.slug }) : null].filter(Boolean).join(' · ');
}

function BackgroundRow({
  app,
  triggers,
  onOpen,
  select,
}: {
  app: App;
  triggers: ProjectTrigger[];
  onOpen: () => void;
  select?: AppSelect;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const status = appStatus(app, t);
  const activity = app.external_url || !app.active_deployment_id
    ? null
    : app.last_request_at
      ? t('text08f59056870d', { value0: relativeTime(app.last_request_at, locale) })
      : t.raw('textbeeb1f954807');

  return (
    // Agent scope: the grant checkbox leads the row, a sibling of the button.
    <li className={cn(select && 'flex items-center gap-3')}>
      {select ? (
        <Checkbox
          checked={select.checked}
          disabled={select.disabled}
          onCheckedChange={select.onToggle}
          aria-label={select.label}
        />
      ) : null}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${app.name}`}
        className="group bg-background hover:bg-muted/40 duration-fast flex w-full items-center gap-3.5 rounded-md border px-4 py-2.5 text-left transition-colors active:scale-[0.998] focus-visible:outline-none"
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            status.deployed ? status.dot : 'border-muted-foreground/50 border bg-transparent',
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-foreground truncate text-sm font-medium">{app.name}</span>
          <span className="text-muted-foreground truncate text-xs">{backgroundMeta(app, triggers, t)}</span>
        </span>
        {select?.note ? (
          <Badge variant="muted" size="xs">
            {select.note}
          </Badge>
        ) : null}
        {activity ? <span className="text-muted-foreground hidden shrink-0 text-xs tabular-nums sm:block">{activity}</span> : null}
        <span className="sr-only">{status.label}</span>
        <CaretRightIcon aria-hidden className="text-muted-foreground group-hover:text-foreground duration-fast size-3.5 shrink-0 transition-colors" />
      </button>
    </li>
  );
}
