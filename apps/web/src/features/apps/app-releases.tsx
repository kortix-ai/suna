'use client';

/**
 * The Releases tab of the App's version sheet: what is live now, then the
 * history under it. Built from the Paper picks "R02 · Live + history" (the
 * list) and "R05 · Inline log" (an opened row).
 *
 * - The live release is a block of its own, not a row with a green pill: it
 *   is the one release that answers "what is serving right now".
 * - A run of failed builds folds into one row. Five red rows in a stack read
 *   as an alarm; "4 failed builds" reads as history.
 * - An opened row shows the deploy STAGES with how long each took. The raw
 *   build output stays one click further down, because it is the thing you
 *   read only when a stage failed.
 */
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import type { App, AppDeployment, AppDeployStrategy } from '@kortix/sdk';
import { useAppDeployment, useAppMachines } from '@kortix/sdk/react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { appCan, localizedAppCopy } from './app-shared';

type Translator = ReturnType<typeof useTranslations>;

/** A history entry: one release, or a run of consecutive failed builds folded into one row. */
export type HistoryItem =
  | { kind: 'release'; deployment: AppDeployment }
  | { kind: 'failed-run'; key: string; deployments: AppDeployment[] };

/** Two or more failed builds in a row fold into one entry. A lone failure stays a row. */
export function historyItems(deployments: AppDeployment[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  let run: AppDeployment[] = [];
  const flush = () => {
    if (run.length >= 2) {
      items.push({ kind: 'failed-run', key: run.map((row) => row.deployment_id).join(':'), deployments: run });
    } else {
      for (const deployment of run) items.push({ kind: 'release', deployment });
    }
    run = [];
  };
  for (const deployment of deployments) {
    if (deployment.status === 'failed') {
      run.push(deployment);
      continue;
    }
    flush();
    items.push({ kind: 'release', deployment });
  }
  flush();
  return items;
}

/** `mm:ss` from the release's first event, the column an opened row lines its stages up on. */
export function elapsed(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function strategyLabel(strategy: AppDeployStrategy, t: Translator): string {
  return {
    bluegreen: t.raw('textb1a7e40c2d0f'),
    rolling: t.raw('textb1a7e40c2d10'),
    immediate: t.raw('textb1a7e40c2d11'),
    canary: t.raw('textb1a7e40c2d12'),
  }[strategy];
}

/** When a release went live, or when it was made when it never did. */
const releasedAt = (deployment: AppDeployment) => deployment.ready_at ?? deployment.created_at;

export function AppReleasesPanel({
  projectId,
  app,
  deployments,
  serving,
  canRollback,
  rollbackPending,
  onRollback,
  initialExpandedId,
}: {
  projectId: string;
  app: App;
  /** Newest first, as `useAppDeployments` returns them. */
  deployments: AppDeployment[];
  /** The App is up: the live block says "Serving traffic", not just the version. */
  serving: boolean;
  canRollback: boolean;
  rollbackPending: boolean;
  onRollback: (deployment: AppDeployment) => void;
  /** Opened on arrival: the header's failure badge asks for its release's log. */
  initialExpandedId: string | null;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const live = deployments.find((row) => row.deployment_id === app.active_deployment_id) ?? null;
  const history = useMemo(
    () => historyItems(deployments.filter((row) => row !== live)),
    [deployments, live],
  );
  const [expandedId, setExpandedId] = useState(initialExpandedId);
  // A failed run opens to show the asked-for release when that release is inside it.
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => {
    const run = history.find(
      (item) => item.kind === 'failed-run' && item.deployments.some((row) => row.deployment_id === initialExpandedId),
    );
    return new Set(run && run.kind === 'failed-run' ? [run.key] : []);
  });
  // Stable, so a toggle re-renders only the rows whose `expanded` changed.
  const onToggle = useCallback((id: string) => setExpandedId((current) => (current === id ? null : id)), []);
  const toggleRun = (key: string) =>
    setOpenRuns((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const row = (deployment: AppDeployment) => (
    <ReleaseRow
      key={deployment.deployment_id}
      projectId={projectId}
      deployment={deployment}
      live={live}
      expanded={expandedId === deployment.deployment_id}
      onToggle={onToggle}
      canRollback={canRollback}
      rollbackPending={rollbackPending}
      onRollback={onRollback}
    />
  );

  return (
    <div className="flex flex-col">
      {live ? <LiveRelease projectId={projectId} app={app} deployment={live} serving={serving} /> : null}
      {history.length ? (
        <section className={cn('flex flex-col gap-1', live && 'pt-6')}>
          <h3 className="text-muted-foreground/70 px-0 pb-1 text-xs font-medium">{t.raw('text0e7696009337')}</h3>
          <ul className="-mx-2 flex flex-col gap-1">
            {history.map((item) => {
              if (item.kind === 'release') return row(item.deployment);
              const open = openRuns.has(item.key);
              const newest = item.deployments[0]!;
              const oldest = item.deployments[item.deployments.length - 1]!;
              return (
                <li key={item.key} className="flex flex-col gap-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleRun(item.key)}
                    className="hover:bg-muted/50 focus-visible:ring-ring flex h-13 items-center gap-3 rounded-md px-2 text-left focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <span className="text-muted-foreground/70 flex w-8 shrink-0 items-center">
                      {open ? <CaretDownIcon className="size-4" /> : <CaretRightIcon className="size-4" />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-foreground text-sm">
                        {t('textb1a7e40c2d08', { value0: item.deployments.length })}
                      </span>
                      <span className="text-muted-foreground/70 font-mono text-xs">
                        v{oldest.version} – v{newest.version}
                      </span>
                    </span>
                    <span className="text-muted-foreground/70 w-15 shrink-0 text-right text-xs tabular-nums">
                      {relativeTime(newest.created_at)}
                    </span>
                    <span className="w-20 shrink-0" aria-hidden />
                  </button>
                  {open ? <ul className="flex flex-col gap-1">{item.deployments.map(row)}</ul> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : !live ? (
        <p className="text-muted-foreground text-xs">{t.raw('textf1fc77ca3b24')}</p>
      ) : null}
    </div>
  );
}

/** The release serving now: its version, since when, and the three facts that describe how it runs. */
function LiveRelease({
  projectId,
  app,
  deployment,
  serving,
}: {
  projectId: string;
  app: App;
  deployment: AppDeployment;
  serving: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const appCopy = localizedAppCopy(t);
  // Only an App with machines has a count to show; `null` keeps the query off.
  const machines = useAppMachines(projectId, appCan(app, 'machines') ? app.app_id : null);
  const running = machines.data?.filter((machine) => machine.state === 'started').length;
  const facts = [
    running !== undefined ? { label: t.raw('textc061da196eae'), value: t('textb1a7e40c2d06', { value0: running }) } : null,
    deployment.strategy ? { label: t.raw('textb1a7e40c2d04'), value: strategyLabel(deployment.strategy, t) } : null,
    deployment.artifact_id
      ? { label: t.raw('textb1a7e40c2d05'), value: deployment.artifact_id.slice(0, 7), mono: true }
      : null,
  ].filter((fact): fact is { label: string; value: string; mono?: boolean } => !!fact);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground/70 text-xs font-medium">{t.raw('textb1a7e40c2d01')}</h3>
      <div className="bg-muted/40 flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <span className="text-foreground font-mono text-sm font-medium">v{deployment.version}</span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              aria-hidden
              className={cn('size-1.5 shrink-0 rounded-full', serving ? 'bg-kortix-green' : 'bg-muted-foreground/70')}
            />
            <span className={cn('truncate text-sm', serving ? 'text-kortix-green' : 'text-muted-foreground')}>
              {serving ? t.raw('textb1a7e40c2d02') : appCopy.deployment.ready.label}
            </span>
          </span>
          <span className="text-muted-foreground/70 shrink-0 text-xs">
            {t('textb1a7e40c2d03', { value0: relativeTime(releasedAt(deployment)) })}
          </span>
        </div>
        {facts.length ? (
          <dl className="flex gap-6">
            {facts.map((fact) => (
              <div key={fact.label} className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground/70 text-xs">{fact.label}</dt>
                <dd className={cn('text-foreground text-sm', fact.mono && 'font-mono')}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

const ReleaseRow = memo(function ReleaseRow({
  projectId,
  deployment,
  live,
  expanded,
  onToggle,
  canRollback,
  rollbackPending,
  onRollback,
}: {
  projectId: string;
  deployment: AppDeployment;
  live: AppDeployment | null;
  expanded: boolean;
  onToggle: (id: string) => void;
  canRollback: boolean;
  rollbackPending: boolean;
  onRollback: (deployment: AppDeployment) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const appCopy = localizedAppCopy(t);
  const failed = deployment.status === 'failed';
  const ready = deployment.status === 'ready';
  // A ready release that is not the live one is "Ready", not "Live".
  const label = ready ? t.raw('text5fa7aac5375c') : appCopy.deployment[deployment.status].label;
  const reason = failed ? deployment.error?.split('\n')[0] : ready ? t.raw('textb1a7e40c2d07') : null;
  const toggleLabel = expanded ? t.raw('textb1a7e40c2d0a') : t.raw('textb1a7e40c2d09');

  // The action slot is fixed-width on every row so the age column lines up.
  const action =
    ready && canRollback ? (
      <Button size="xs" variant="secondary" disabled={rollbackPending} onClick={() => onRollback(deployment)}>
        {rollbackPending ? <Loading className="size-3.5 shrink-0" /> : null}
        {t.raw('texta76e13b98392')}
      </Button>
    ) : failed && !expanded ? (
      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => onToggle(deployment.deployment_id)}>
        {t.raw('textb1a7e40c2d09')}
      </Button>
    ) : null;

  if (expanded) {
    return (
      <li className="bg-muted/50 flex flex-col rounded-lg pb-2">
        {/* Same lanes as a closed row (age w-15, action w-20, gap-3), so
            opening a row moves nothing on its right edge. */}
        <div className="flex h-11 items-center gap-3 px-2">
          <button
            type="button"
            aria-expanded
            aria-label={`${toggleLabel} v${deployment.version}`}
            onClick={() => onToggle(deployment.deployment_id)}
            className="focus-visible:ring-ring flex h-full min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:outline-none"
          >
            <CaretDownIcon className="text-foreground size-4 shrink-0" aria-hidden />
            <span className="text-foreground w-8 shrink-0 font-mono text-sm">v{deployment.version}</span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span
                aria-hidden
                className={cn('size-1.5 shrink-0 rounded-full', failed ? 'bg-destructive' : 'bg-muted-foreground/70')}
              />
              <span className={cn('truncate text-sm', failed ? 'text-destructive' : 'text-foreground')}>{label}</span>
            </span>
            <span className="text-muted-foreground/70 w-15 shrink-0 text-right text-xs tabular-nums">
              {relativeTime(deployment.created_at)}
            </span>
          </button>
          <span className="flex w-20 shrink-0 justify-end">{action}</span>
        </div>
        <ReleaseLog projectId={projectId} deployment={deployment} live={live} />
      </li>
    );
  }

  return (
    <li className="hover:bg-muted/50 flex h-13 items-center gap-3 rounded-md px-2">
      <button
        type="button"
        aria-expanded={false}
        aria-label={`${toggleLabel} v${deployment.version}`}
        onClick={() => onToggle(deployment.deployment_id)}
        className="focus-visible:ring-ring flex h-full min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="text-foreground w-8 shrink-0 font-mono text-sm font-medium">v{deployment.version}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn('text-sm', failed ? 'text-destructive' : 'text-foreground')}>{label}</span>
          {reason ? <span className="text-muted-foreground/70 truncate text-xs">{reason}</span> : null}
        </span>
        <span className="text-muted-foreground/70 w-15 shrink-0 text-right text-xs tabular-nums">
          {relativeTime(deployment.created_at)}
        </span>
      </button>
      <span className="flex w-20 shrink-0 justify-end">{action}</span>
    </li>
  );
});

/**
 * One release's deploy, as stages: an icon, what happened, and when relative
 * to the start. Build output is the noisy part, so it waits behind a toggle.
 */
function ReleaseLog({
  projectId,
  deployment,
  live,
}: {
  projectId: string;
  deployment: AppDeployment;
  live: AppDeployment | null;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const detail = useAppDeployment(projectId, deployment.app_id, deployment.deployment_id);
  const [showOutput, setShowOutput] = useState(deployment.status === 'failed');
  const events = detail.data?.events;
  const { stages, output } = useMemo(() => {
    const all = events ?? [];
    return {
      stages: all.filter((event) => event.type !== 'build_log'),
      output: all.filter((event) => event.type === 'build_log').map((event) => event.message).join('\n'),
    };
  }, [events]);
  const start = events?.[0]?.created_at;
  // An older ready release was replaced by the live one.
  const replaced =
    deployment.status === 'ready' && live && live.version > deployment.version ? live : null;

  return (
    <div className="bg-background mx-2 flex flex-col gap-0.5 rounded-md border px-3 py-2.5">
      {detail.isLoading ? (
        <Loading className="text-muted-foreground" />
      ) : detail.isError ? (
        <p className="text-muted-foreground text-xs">{t.raw('text245c1e26ba4c')}</p>
      ) : !stages.length && !output ? (
        <p className="text-muted-foreground text-xs">{t.raw('text80c652c4eeec')}</p>
      ) : (
        stages.map((event) => (
          <LogLine
            key={event.event_id}
            tone={event.level === 'error' ? 'error' : 'done'}
            text={event.message}
            time={start ? elapsed(start, event.created_at) : null}
          />
        ))
      )}
      {deployment.status === 'failed' && deployment.error ? (
        <LogLine tone="error" text={deployment.error.split('\n')[0]!} time={null} />
      ) : null}
      {replaced ? (
        <LogLine
          tone="muted"
          text={t('textb1a7e40c2d0c', { value0: replaced.version, value1: relativeTime(releasedAt(replaced)) })}
          time={null}
        />
      ) : null}
      {output ? (
        // A hairline between the stages and the raw output: two kinds of
        // text, one above the other, read as one list without it.
        <div className="-mx-3 mt-1.5 flex flex-col border-t px-3 pt-2">
          <button
            type="button"
            onClick={() => setShowOutput((value) => !value)}
            className="text-muted-foreground hover:text-foreground w-fit text-xs"
          >
            {showOutput ? t.raw('textb1a7e40c2d0e') : t.raw('textb1a7e40c2d0d')}
          </button>
          {/* `whitespace-pre`, not `pre-wrap`: up to 5,001 lines re-wrapped on
              every layout stalled the unfold. `contain-content` keeps its
              layout from reaching the list around it. */}
          {showOutput ? (
            <pre className="text-muted-foreground mt-1 max-h-64 overflow-auto font-mono text-xs whitespace-pre contain-content">
              {output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The Paper pick's stage glyphs: a check, a cross, a dash. 14px on a 16 grid. */
const LOG_GLYPH = {
  done: 'M3.5 8.5l3 3 6-7',
  error: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  muted: 'M4 8h8',
} as const;

function LogLine({ tone, text, time }: { tone: 'done' | 'error' | 'muted'; text: string; time: string | null }) {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className={cn(
          'size-3.5 shrink-0 fill-none stroke-current stroke-[1.5]',
          tone === 'done' && 'text-kortix-green',
          tone === 'error' && 'text-destructive',
          tone === 'muted' && 'text-muted-foreground/70',
        )}
      >
        <path d={LOG_GLYPH[tone]} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-xs',
          tone === 'muted' ? 'text-muted-foreground' : tone === 'error' ? 'text-destructive' : 'text-foreground',
        )}
      >
        {text}
      </span>
      {time ? <span className="text-muted-foreground/70 shrink-0 font-mono text-xs tabular-nums">{time}</span> : null}
    </div>
  );
}
