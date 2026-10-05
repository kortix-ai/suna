'use client';

import type { CaptureAction, CaptureAudioLine, CaptureEpisode } from '@kortix/sdk';
import { useCaptureEpisode, useCaptureWorkflow } from '@kortix/sdk/react';
import { CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { captureHref } from '../area/use-capture-area';
import { clockTime, indexAtOrBefore } from '../capture-time';
import { useRunDuration } from '../intelligence/workflow-ui';

/** Steps shown around the playhead: this many before the current one and after it. */
const AROUND = 4;

/**
 * The right panel of a device timeline: what is on screen at the playhead,
 * the actions around it (click one to move there), and what was said. It
 * follows the playhead, so scrubbing reads the steps as they happen.
 */
export function MomentPanel({
  className,
  at,
  app,
  title,
  url,
  actions,
  audio,
  onJump,
  accountId,
  episode,
}: {
  accountId: string;
  /** The episode under the playhead: the panel shows it instead of the raw moment. */
  episode: CaptureEpisode | null;
  className?: string;
  at: number;
  app: string | null;
  title: string | null;
  url: string | null;
  actions: readonly CaptureAction[];
  audio: readonly CaptureAudioLine[];
  onJump: (at: number) => void;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  if (episode)
    return (
      <EpisodePanel
        className={className}
        accountId={accountId}
        episode={episode}
        at={at}
        onJump={onJump}
      />
    );
  return (
    <Moment
      className={className}
      at={at}
      app={app}
      title={title}
      url={url}
      actions={actions}
      audio={audio}
      onJump={onJump}
    />
  );
}

function Moment({
  className,
  at,
  app,
  title,
  url,
  actions,
  audio,
  onJump,
}: {
  className?: string;
  at: number;
  app: string | null;
  title: string | null;
  url: string | null;
  actions: readonly CaptureAction[];
  audio: readonly CaptureAudioLine[];
  onJump: (at: number) => void;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  const current = indexAtOrBefore(actions, at);
  const start = Math.max(0, Math.min(current - AROUND, actions.length - AROUND * 2 - 1));
  const shown = actions.slice(start, start + AROUND * 2 + 1);
  const said = audio
    .filter((line) => Date.parse(line.end_at) >= at - 60_000 && Date.parse(line.ts) <= at + 60_000)
    .slice(0, 4);

  return (
    <aside
      aria-labelledby="capture-moment-title"
      className={cn('bg-background flex flex-col rounded-md border', className)}
    >
      <div className="space-y-1.5 border-b px-4 py-4">
        <p className="text-muted-foreground text-xs">{t('moment.eyebrow')}</p>
        <h2
          id="capture-moment-title"
          className="text-foreground text-base font-medium text-balance"
        >
          {app ?? t('moment.nothing')}
        </h2>
        <p className="text-muted-foreground font-mono text-xs tabular-nums">
          {new Date(at).toLocaleString(locale, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </p>
      </div>
      {title || url ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b px-4 py-3 text-xs">
          {title ? (
            <>
              <dt className="text-muted-foreground">{t('moment.window')}</dt>
              <dd className="text-foreground wrap-anywhere">{title}</dd>
            </>
          ) : null}
          {url ? (
            <>
              <dt className="text-muted-foreground">{t('moment.address')}</dt>
              <dd className="text-foreground font-mono wrap-anywhere">{url}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <div className="flex flex-col gap-0.5 px-2 py-3">
        <p className="text-muted-foreground px-2 pb-1.5 text-xs">{t('moment.steps')}</p>
        {shown.length === 0 ? (
          <p className="text-muted-foreground px-2 py-2 text-xs">{t('moment.noSteps')}</p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {shown.map((action) => {
              const on = actions[current]?.action_id === action.action_id;
              return (
                <li key={action.action_id}>
                  <button
                    type="button"
                    aria-current={on ? 'step' : undefined}
                    onClick={() => onJump(Date.parse(action.ts))}
                    className={cn(
                      'hover:bg-hover grid w-full grid-cols-[auto_minmax(0,1fr)] items-baseline gap-3 rounded-sm px-2 py-1.5 text-left transition-colors',
                      on && 'bg-active',
                    )}
                  >
                    <span className="text-muted-foreground font-mono text-xs tabular-nums">
                      {clockTime(action.ts, locale, true)}
                    </span>
                    <span className="min-w-0 text-sm">
                      <span className="text-foreground wrap-anywhere">
                        {action.description ?? action.kind}
                      </span>
                      {action.app ? (
                        <span className="text-muted-foreground text-xs"> · {action.app}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {said.length > 0 ? (
        <div className="space-y-1.5 border-t px-4 py-3">
          <p className="text-muted-foreground text-xs">{t('moment.said')}</p>
          {said.map((line) => (
            <button
              key={line.line_id}
              type="button"
              onClick={() => onJump(Date.parse(line.ts))}
              className="hover:bg-hover -mx-2 block w-full rounded-sm px-2 py-1 text-left text-sm transition-colors"
            >
              <span className="text-muted-foreground mr-2 font-mono text-xs tabular-nums">
                {clockTime(line.ts, locale, true)}
              </span>
              {line.text}
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

/**
 * The episode under the playhead (L1/L2): its goal and outcome, its steps
 * (the current one follows the playhead; a step moves the playhead), and the
 * workflow it is a run of.
 */
function EpisodePanel({
  className,
  accountId,
  episode,
  at,
  onJump,
}: {
  className?: string;
  accountId: string;
  episode: CaptureEpisode;
  at: number;
  onJump: (at: number) => void;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  const duration = useRunDuration();
  const detail = useCaptureEpisode(accountId, episode.episode_id);
  const workflow = useCaptureWorkflow(accountId, episode.workflow_id);
  const steps = detail.data?.steps ?? [];
  const current = indexAtOrBefore(steps, at);
  const variant = workflow.data?.variants.find((v) => v.key === episode.variant_key);
  return (
    <aside
      aria-labelledby="capture-episode-title"
      className={cn('bg-background flex flex-col rounded-md border', className)}
    >
      <div className="space-y-2 border-b px-4 py-4">
        <p className="text-muted-foreground text-xs">{t('episode.eyebrow')}</p>
        <h2
          id="capture-episode-title"
          className="text-foreground text-base font-medium text-balance"
        >
          {episode.label ?? episode.goal ?? t('episode.untitled')}
        </h2>
        <p className="text-muted-foreground font-mono text-xs tabular-nums">
          {clockTime(episode.start_at, locale)} – {clockTime(episode.end_at, locale)} ·{' '}
          {duration(episode.duration_s)}
        </p>
        {episode.apps.length ? (
          <div className="flex flex-wrap gap-1.5">
            {episode.apps.map((name) => (
              <Badge key={name} variant="muted" size="sm" className="normal-case">
                {name}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      {episode.goal || episode.outcome ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b px-4 py-3 text-sm">
          {episode.goal ? (
            <>
              <dt className="text-muted-foreground text-xs leading-5">{t('episode.goal')}</dt>
              <dd className="text-foreground">{episode.goal}</dd>
            </>
          ) : null}
          {episode.outcome ? (
            <>
              <dt className="text-muted-foreground text-xs leading-5">{t('episode.outcome')}</dt>
              <dd className="text-foreground flex items-start gap-1.5">
                {episode.outcome_status === 'succeeded' ? (
                  <CheckCircleIcon
                    weight="fill"
                    className="text-kortix-green mt-0.5 size-4 shrink-0"
                  />
                ) : episode.outcome_status ? (
                  <WarningCircleIcon
                    weight="fill"
                    className="text-kortix-orange mt-0.5 size-4 shrink-0"
                  />
                ) : null}
                {episode.outcome}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <div className="flex flex-col gap-0.5 border-b px-2 py-3">
        <p className="text-muted-foreground px-2 pb-1.5 text-xs">
          {t('episode.steps', { count: episode.steps_count })}
        </p>
        {detail.isLoading ? (
          <div className="space-y-1.5 px-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-7 rounded-sm" />
            ))}
          </div>
        ) : steps.length === 0 ? (
          <p className="text-muted-foreground px-2 py-2 text-xs">{t('episode.noSteps')}</p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {steps.map((step, i) => (
              <li key={step.index}>
                <button
                  type="button"
                  aria-current={i === current ? 'step' : undefined}
                  onClick={() => onJump(Date.parse(step.ts))}
                  className={cn(
                    'hover:bg-hover grid w-full grid-cols-[auto_minmax(0,1fr)] items-baseline gap-3 rounded-sm px-2 py-1.5 text-left transition-colors',
                    i === current && 'bg-active',
                  )}
                >
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {clockTime(step.ts, locale, true)}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                    <span className="text-foreground font-medium">{step.verb}</span>
                    <span className="text-foreground">{step.object}</span>
                    {step.variables.map((v) => (
                      <Badge key={v} variant="outline" size="xs" className="font-mono normal-case">
                        {`{${v}}`}
                      </Badge>
                    ))}
                    {step.app ? (
                      <span className="text-muted-foreground text-xs">· {step.app}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {workflow.data ? (
        <Link
          href={captureHref(accountId, 'workflows', `/${workflow.data.workflow_id}`)}
          className="hover:bg-hover m-4 flex flex-col gap-0.5 rounded-md border px-3 py-2.5 transition-colors"
        >
          <span className="text-muted-foreground text-xs">{t('episode.partOf')}</span>
          <span className="text-foreground text-sm font-medium">{workflow.data.name}</span>
          {variant ? (
            <span className="text-muted-foreground text-xs">
              {t('episode.variant', { key: variant.key, name: variant.name })}
            </span>
          ) : null}
        </Link>
      ) : !episode.workflow_id ? (
        <p className="text-muted-foreground px-4 py-3 text-xs">{t('episode.noWorkflow')}</p>
      ) : null}
    </aside>
  );
}
