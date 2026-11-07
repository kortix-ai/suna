'use client';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { Field, FieldDescription, FieldLabel } from '@kortix/ui/field';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { appTriggers } from '@kortix/ui/apps';
import { cn } from '@kortix/ui';
import { ApiError, type App, type AppEvent, type AppEventStatus, type ProjectTrigger } from '@kortix/sdk';
import { useAppEvents, useSendAppTestEvent } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, BroadcastIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { UiTranslator } from '@/i18n/translator';

/** Rows the overview shows; `kortix apps events` reads further back. */
const SHOWN = 20;
/** Rows read to count the last 24 hours. */
const COUNTED = 100;
/** One event reaches at most this many triggers' rows. */
const FOCUS_LIMIT = 50;
const DAY_MS = 24 * 60 * 60_000;

/** One hue per outcome (kortix-brand color.md, status table); the words stay ink. */
const OUTCOME_DOT: Record<AppEventStatus, string> = {
  fired: 'bg-kortix-green',
  pending: 'bg-kortix-yellow',
  skipped: 'bg-muted-foreground',
  suppressed: 'bg-kortix-orange',
  failed: 'bg-kortix-red',
  // By design, and a person can act: add a trigger.
  unmatched: 'bg-kortix-orange',
};

function outcomeLabel(status: AppEventStatus, t: UiTranslator): string {
  switch (status) {
    case 'fired':
      return t.raw('text76456efd96b6');
    case 'pending':
      return t.raw('text6e293a8c009e');
    case 'skipped':
      return t.raw('text12698ce1ea5c');
    case 'suppressed':
      return t.raw('textd5a6dc64b5d4');
    case 'failed':
      return t.raw('text95d2f57f8fa4');
    case 'unmatched':
      return t.raw('text6119feb6e4f5');
  }
}

/** When the App last posted to any of its triggers (a deduplicated post and a heartbeat count). */
export function appLastEventAt(app: App, triggers: ProjectTrigger[]): string | null {
  const stamps = appTriggers(app, triggers).startsOn.flatMap((trigger) => (trigger.last_event_at ? [trigger.last_event_at] : []));
  return stamps.length ? stamps.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/** The earliest open silence alert on the App's triggers, or null. */
export function appSilentSince(app: App, triggers: ProjectTrigger[]): string | null {
  const stamps = appTriggers(app, triggers).startsOn.flatMap((trigger) => (trigger.silent_since ? [trigger.silent_since] : []));
  return stamps.length ? stamps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

/** The earliest open crash alert on the App's triggers: the always-on App is down past its restart budget. Null when none. */
export function appCrashedSince(app: App, triggers: ProjectTrigger[]): string | null {
  const stamps = appTriggers(app, triggers).startsOn.flatMap((trigger) => (trigger.crashed_since ? [trigger.crashed_since] : []));
  return stamps.length ? stamps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

/** "14:02", or the date and time when it is not today. */
export function clockTime(iso: string, locale: string): string {
  const at = new Date(iso);
  const today = at.toDateString() === new Date().toDateString();
  return today
    ? at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The overview's "Last event" fact: when the App last posted, since when it
 * has been down past its restart budget, or since when it has been silent
 * past a trigger's `expect_event_within`. Null for an App no trigger listens to.
 */
export function LastEventFact({ app, triggers }: { app: App; triggers: ProjectTrigger[] }): ReactNode {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  if (appTriggers(app, triggers).startsOn.length === 0) return null;
  const last = appLastEventAt(app, triggers);
  const crashed = appCrashedSince(app, triggers);
  if (crashed) {
    return (
      <span className="flex items-center gap-2">
        <span aria-hidden className="bg-kortix-red size-1.5 shrink-0 rounded-full" />
        {t('text1ade727f7313', { value0: clockTime(crashed, locale) })}
      </span>
    );
  }
  const silent = appSilentSince(app, triggers);
  if (silent) {
    return (
      <span className="flex items-center gap-2">
        <span aria-hidden className="bg-kortix-orange size-1.5 shrink-0 rounded-full" />
        {t('text7b5f87420cb2', { value0: last ? clockTime(last, locale) : clockTime(silent, locale) })}
      </span>
    );
  }
  return <span className="tabular-nums">{last ? relativeTime(last, locale) : t.raw('textadb85cf22bfc')}</span>;
}

/**
 * The App's events (`GET …/apps/:appId/events`) for a viewer with the
 * operations view: what it posted and what came of each, newest first, and a
 * test event that takes the real path. The App's own `kortix apps events`
 * reads further back.
 */
export function AppEventsSection({
  projectId,
  app,
  triggers,
  focusEventId = null,
}: {
  projectId: string;
  app: App;
  triggers: ProjectTrigger[];
  /** Show only this event's rows (a trigger run's link) until the reader asks for all. */
  focusEventId?: string | null;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const [focus, setFocus] = useState<string | null>(focusEventId);
  const events = useAppEvents(projectId, app.app_id, { limit: focus ? FOCUS_LIMIT : COUNTED, id: focus });
  const [testOpen, setTestOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  // A link to one event lands on it: the section scrolls into view once.
  useEffect(() => {
    if (focusEventId) sectionRef.current?.scrollIntoView({ block: 'start' });
  }, [focusEventId]);
  // A viewer without the operations view gets 403: the section is not theirs.
  if (events.error instanceof ApiError && events.error.status === 403) return null;

  const rows = events.data?.events ?? [];
  // Count against the time of the fetch, so a re-render cannot move the window.
  const fetchedAt = events.dataUpdatedAt;
  const recent = rows.filter((row) => fetchedAt - Date.parse(row.received_at) < DAY_MS);
  const capped = rows.length === COUNTED && recent.length === COUNTED;
  const started = recent.filter((row) => row.status === 'fired').length;

  return (
    <section ref={sectionRef} className="space-y-3 scroll-mt-4" aria-labelledby="app-events-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="app-events-title" className="text-foreground text-sm font-medium">
            {t.raw('text8d14f6e72de8')}
          </h2>
          <p className="text-muted-foreground text-xs text-pretty">
            {t.raw('textc235cb1df45b')}
          </p>
        </div>
        <Button size="sm" variant="secondary" className="shrink-0 gap-1.5" onClick={() => setTestOpen(true)}>
          <PaperPlaneTiltIcon className="size-4 shrink-0" />
          {t.raw('textbcd7586101a4')}
        </Button>
      </div>

      {events.isPending ? (
        <ul className="divide-border divide-y overflow-hidden rounded-md border" aria-busy>
          {[0, 1, 2].map((key) => (
            <li key={key} className="flex h-10 items-center gap-3 px-3">
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="ml-auto h-3 w-12" />
            </li>
          ))}
        </ul>
      ) : events.isError && !events.data ? (
        // A failed 10 s refresh keeps the rows already shown; only a first load that fails shows this.
        <ErrorState
          size="sm"
          title={t.raw('textb31f231088c9')}
          action={
            <Button variant="outline" size="sm" onClick={() => void events.refetch()}>
              {t.raw('textd8b8392e2c54')}
            </Button>
          }
        />
      ) : focus ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground min-w-0 truncate text-xs">
              {t('text8521b7841a0c', { value0: focus })}
            </p>
            <Button variant="ghost" size="xs" className="text-muted-foreground shrink-0 text-xs" onClick={() => setFocus(null)}>
              {t.raw('textbede9e3c96af')}
            </Button>
          </div>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t.raw('text216e5ffc0e54')}</p>
          ) : (
            <ul className="divide-border divide-y overflow-hidden rounded-md border">
              {rows.map((row) => (
                <EventRow key={row.log_id} projectId={projectId} row={row} locale={locale} t={t} initialOpen />
              ))}
            </ul>
          )}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          media={<EmptyArt icon={BroadcastIcon} />}
          title={t.raw('text863f2373ad58')}
          description={t.raw('text4b97770f1f09')}
        />
      ) : (
        <>
          <p className="text-muted-foreground text-xs tabular-nums">
            {t('text66a6b0caa7b8', {
              value0: capped ? `${COUNTED}+` : String(recent.length),
              value1: String(started),
            })}
          </p>
          <ul className="divide-border divide-y overflow-hidden rounded-md border">
            {rows.slice(0, SHOWN).map((row) => (
              <EventRow key={row.log_id} projectId={projectId} row={row} locale={locale} t={t} />
            ))}
          </ul>
        </>
      )}

      <SendTestEventModal
        open={testOpen}
        onOpenChange={setTestOpen}
        projectId={projectId}
        app={app}
        defaultName={defaultEventName(app, triggers)}
      />
    </section>
  );
}

/** The event name the App's first named trigger listens for, for the test form. */
function defaultEventName(app: App, triggers: ProjectTrigger[]): string {
  for (const trigger of appTriggers(app, triggers).startsOn) {
    const name = (trigger.filter as Record<string, unknown> | null)?.['event.name'];
    if (typeof name === 'string' && name) return name;
  }
  return 'status.changed';
}

function EventRow({
  projectId,
  row,
  locale,
  t,
  initialOpen = false,
}: {
  projectId: string;
  row: AppEvent;
  locale: string;
  t: UiTranslator;
  /** Start expanded: the one event a link opened. */
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const reason = row.status === 'suppressed'
    ? t.raw('text4e18ffd436f1')
    : row.reason;
  return (
    <li className={cn(open && 'bg-muted')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'focus-visible:ring-ring flex h-10 w-full items-center gap-3 px-3 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset',
          !open && 'hover:bg-hover duration-fast transition-colors',
        )}
      >
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', OUTCOME_DOT[row.status])} />
        <span className="text-foreground shrink-0 font-medium">{outcomeLabel(row.status, t)}</span>
        <span className="text-muted-foreground min-w-0 truncate font-mono">{row.name ?? row.raw ?? ''}</span>
        {row.test ? (
          <Badge variant="secondary" size="sm" className="shrink-0 font-sans normal-case">
            {t.raw('text532eaabd9574')}
          </Badge>
        ) : null}
        <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">{relativeTime(row.received_at, locale)}</span>
      </button>
      {open ? (
        <div className="space-y-2 px-3 pt-1 pb-3 pl-8 text-xs">
          <Detail label={t.raw('text8b9c643731c9')}>{row.trigger ?? '—'}</Detail>
          {row.id ? (
            <Detail label={t.raw('text3045abafb173')}>
              <span className="font-mono wrap-anywhere">{row.id}</span>
            </Detail>
          ) : null}
          {reason ? (
            <Detail label={t.raw('textf81ab834de5f')}>
              <span className="wrap-anywhere">{reason}</span>
            </Detail>
          ) : null}
          <pre className="bg-popover text-foreground overflow-auto rounded-md border px-3 py-2.5 font-mono text-xs whitespace-pre">
            {row.truncated ? row.raw : JSON.stringify(row.data ?? {}, null, 2)}
          </pre>
          {row.session_id ? (
            <Button variant="ghost" size="xs" className="text-muted-foreground -ml-2 flex w-fit gap-1.5 text-xs" asChild>
              <Link href={`/workspaces/${projectId}/sessions/${row.session_id}`}>
                <ArrowSquareOutIcon className="size-3 shrink-0" />
                {t.raw('textb205bb47f81a')}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <span className="text-foreground min-w-0">{children}</span>
    </div>
  );
}

function SendTestEventModal({
  open,
  onOpenChange,
  projectId,
  app,
  defaultName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  app: App;
  defaultName: string;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const send = useSendAppTestEvent(projectId, app.app_id);
  const [name, setName] = useState(defaultName);
  const [data, setData] = useState('{}');
  const [dataError, setDataError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.trim() || '{}');
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setDataError(t.raw('text119ec5b50a07'));
      return;
    }
    setDataError(null);
    send.mutate(
      { name: name.trim(), data: parsed as Record<string, unknown> },
      {
        onSuccess: () => {
          successToast(t.raw('text07aaf9c9f315'));
          onOpenChange(false);
        },
        onError: (error) => {
          errorToast(t.raw('text72b8a74d4eee'), { description: error instanceof Error ? error.message : undefined });
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (send.isPending) return;
        if (next) {
          setName(defaultName);
          setDataError(null);
        }
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t.raw('text028284e97d7d')}</ModalTitle>
          <ModalDescription>
            {t.raw('text568b8fae25a4')}
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={submit} autoComplete="off">
          <ModalBody className="space-y-4">
            <Field>
              <FieldLabel htmlFor="app-test-event-name">{t.raw('text25bc9efedfb7')}</FieldLabel>
              <Input id="app-test-event-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" required />
            </Field>
            <Field data-invalid={dataError ? true : undefined}>
              <FieldLabel htmlFor="app-test-event-data">{t.raw('text0760ef976f73')}</FieldLabel>
              <Textarea
                id="app-test-event-data"
                value={data}
                onChange={(e) => setData(e.target.value)}
                rows={5}
                className="font-mono text-xs"
                aria-invalid={dataError ? true : undefined}
              />
              {dataError ? <FieldDescription>{dataError}</FieldDescription> : null}
            </Field>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)} disabled={send.isPending}>
              {t.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={send.isPending || !name.trim()} aria-busy={send.isPending || undefined}>
              {send.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t.raw('textbcd7586101a4')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
