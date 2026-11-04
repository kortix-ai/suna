'use client';

import { Button } from '@kortix/ui/button';
import { CopyButton } from '@kortix/ui/markdown';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { DeployCommand, appCommand, appHost, appSizeLabel, appStatus, appTriggers } from '@kortix/ui/apps';
import { cn } from '@kortix/ui';
import { type App, type AppDeployment, type ProjectTrigger } from '@kortix/sdk';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { UiTranslator } from '@/i18n/translator';
import type { ReactNode } from 'react';

/**
 * What a background App shows when it is opened: it has no page, so the view
 * says what it is and what it does instead of framing nothing.
 *
 * Each row answers one question a person opens a background App with: is it
 * up, how does it run, what calls it, which agents does it start, how big is
 * it, where does it answer. A row with no answer is left out.
 */
export function AppOverview({
  app,
  triggers,
  latest,
  onVersions,
}: {
  app: App;
  triggers: ProjectTrigger[];
  /** The newest deployment, when the viewer may read deployments. */
  latest?: AppDeployment;
  /** Absent: the viewer may not see versions. */
  onVersions?: () => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const status = appStatus(app, t);
  const { calledBy, startsOn } = appTriggers(app, triggers);
  const isStatic = app.hosting_type === 'static';
  const activity = app.last_request_at ? t('text08f59056870d', { value0: relativeTime(app.last_request_at, locale) }) : null;

  return (
    <div className="absolute inset-0 overflow-y-auto" data-testid="app-overview">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-7 px-4 py-12 pb-20 md:py-16">
        <header className="space-y-1.5">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">{app.name}</h1>
          <p className="text-muted-foreground text-sm text-pretty">{t.raw('texteac997a26ac5')}</p>
        </header>

        {status.deployed ? (
          <dl className="bg-background overflow-hidden rounded-md border">
            <Fact label={t.raw('text920e413c7d41')}>
              <span className="flex items-center gap-2">
                <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', status.dot)} />
                {[status.label, activity].filter(Boolean).join(' · ')}
              </span>
            </Fact>
            {isStatic ? null : (
              <Fact label={t.raw('text848f54e89660')}>
                {app.always_on
                  ? t.raw('text853696d5a64d')
                  : t('textfaca381ebe87', { value0: Math.round(app.idle_timeout_seconds / 60) })}
              </Fact>
            )}
            {calledBy.length ? (
              <Fact label={t.raw('textcb0a5f32744d')}>
                <TriggerList t={t} rows={calledBy} detail={(row) => (row.target?.path ? `→ ${row.target.path}` : null)} />
              </Fact>
            ) : null}
            {startsOn.length ? (
              <Fact label={t.raw('text5265247cedb4')}>
                <TriggerList t={t} rows={startsOn} detail={() => null} />
              </Fact>
            ) : null}
            {isStatic ? null : <Fact label={t.raw('text1af851907331')}>{appSizeLabel(app, t)}</Fact>}
            <Fact label={t.raw('texte7a241debad5')}>
              <span className="flex min-w-0 items-center gap-1.5">
                <a
                  href={app.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground truncate font-mono text-xs hover:underline"
                >
                  {appHost(app.url)}
                </a>
                <CopyButton code={app.url} size="sm" className="shrink-0" />
              </span>
            </Fact>
          </dl>
        ) : (
          <section className="bg-background space-y-3 rounded-md border border-dashed px-4 py-5">
            <p className="text-foreground text-sm font-medium">{t.raw('text94ecd43f8b2b')}</p>
            <p className="text-muted-foreground text-xs">{t.raw('text22f3da948b4b')}</p>
            <DeployCommand code={appCommand(app)} />
          </section>
        )}

        {/* What wires the App in, deployed or not: an App's triggers are worth
            seeing before its first version as much as after. */}
        {!status.deployed && (calledBy.length || startsOn.length) ? (
          <dl className="bg-background overflow-hidden rounded-md border">
            {calledBy.length ? (
              <Fact label={t.raw('textcb0a5f32744d')}>
                <TriggerList t={t} rows={calledBy} detail={(row) => (row.target?.path ? `→ ${row.target.path}` : null)} />
              </Fact>
            ) : null}
            {startsOn.length ? (
              <Fact label={t.raw('text5265247cedb4')}>
                <TriggerList t={t} rows={startsOn} detail={() => null} />
              </Fact>
            ) : null}
          </dl>
        ) : null}

        {status.deployed && (latest || onVersions) ? (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {latest ? (
              <span className="tabular-nums">
                {t('textc8814bbd2883', { value0: latest.version, value1: relativeTime(latest.created_at, locale) })}
              </span>
            ) : null}
            {onVersions ? (
              <Button size="sm" variant="transparent" className="h-auto px-0 text-xs" onClick={onVersions}>
                {t.raw('text6473ccf96fd6')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-foreground min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function TriggerList({ t, rows, detail }: { t: UiTranslator; rows: ProjectTrigger[]; detail: (row: ProjectTrigger) => string | null }) {
  return (
    <ul className="space-y-1">
      {rows.map((row) => (
        <li key={row.slug} className="truncate">
          <span className="text-foreground">{row.name || row.slug}</span>
          {detail(row) ? <span className="text-muted-foreground"> {detail(row)}</span> : null}
          {row.enabled ? null : <span className="text-muted-foreground"> · {t.raw('textca7981b46ecf')}</span>}
        </li>
      ))}
    </ul>
  );
}
