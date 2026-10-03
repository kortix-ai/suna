'use client';

import type { CaptureAction, CaptureAudioLine, CaptureFrame, CaptureRange } from '@kortix/sdk';
import Link from 'next/link';

import { Label } from '@/components/ui/label';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { clockTime, shortDate } from '../capture-time';
import type { TrackLayers } from './timeline-track';

const NEAR_MS = 2 * 60_000;

/** What happened at the moment: the screen, the actions and the audio within two minutes, and its range. */
export function MomentDetails({
  projectId,
  userParam,
  at,
  frame,
  ocrText,
  actions,
  audio,
  range,
  layers,
}: {
  projectId: string;
  userParam: string | null;
  at: number;
  frame: CaptureFrame | null;
  ocrText: string | null;
  actions: CaptureAction[];
  audio: CaptureAudioLine[];
  range: CaptureRange | null;
  layers: TrackLayers;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  const near = <T extends { ts: string }>(items: T[]) =>
    items.filter((item) => Math.abs(Date.parse(item.ts) - at) <= NEAR_MS).slice(0, 8);
  const nearActions = near(actions);
  const nearAudio = near(audio);

  return (
    <aside
      className="bg-background space-y-5 self-start rounded-md border px-4 py-5"
      aria-label={t('details.label')}
    >
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs tabular-nums">
          {shortDate(at, locale)} · {clockTime(at, locale, true)}
        </p>
        <p className="text-foreground text-sm font-medium wrap-anywhere">
          {frame?.app ?? t('details.noScreen')}
        </p>
        {frame?.title ? (
          <p className="text-muted-foreground text-xs wrap-anywhere">{frame.title}</p>
        ) : null}
        {frame?.url ? (
          <a
            href={frame.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs wrap-anywhere underline-offset-2 hover:underline"
          >
            {frame.url}
          </a>
        ) : null}
      </div>

      {layers.screen && ocrText ? (
        <section className="space-y-2">
          <Label>{t('details.onScreen')}</Label>
          <p className="text-muted-foreground line-clamp-6 text-xs text-pretty wrap-anywhere">
            {ocrText}
          </p>
        </section>
      ) : null}

      {layers.actions ? (
        <section className="space-y-2">
          <Label>{t('details.actions')}</Label>
          {nearActions.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('details.noActions')}</p>
          ) : (
            <ul className="space-y-1.5">
              {nearActions.map((action) => (
                <li key={action.action_id} className="flex gap-3 text-xs">
                  <span className="text-muted-foreground w-20 shrink-0 whitespace-nowrap tabular-nums">
                    {clockTime(action.ts, locale, true)}
                  </span>
                  <span className="min-w-0 wrap-anywhere">{action.description ?? action.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {layers.audio ? (
        <section className="space-y-2">
          <Label>{t('details.audio')}</Label>
          {nearAudio.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('details.noAudio')}</p>
          ) : (
            <ul className="space-y-1.5">
              {nearAudio.map((line) => (
                <li key={line.line_id} className="flex gap-3 text-xs">
                  <span className="text-muted-foreground w-20 shrink-0 whitespace-nowrap tabular-nums">
                    {clockTime(line.ts, locale, true)}
                  </span>
                  <span className="min-w-0 text-pretty">{line.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {range ? (
        <p className="border-t pt-4 text-xs">
          {t('details.partOf')}{' '}
          <Link
            href={`/projects/${projectId}/capture/ranges/${range.range_id}${userParam ? `?user=${userParam}` : ''}`}
            className="font-medium underline-offset-2 hover:underline"
          >
            {range.title ??
              t('rangeSpan', {
                from: clockTime(range.start_at, locale),
                to: clockTime(range.end_at, locale),
              })}
          </Link>
        </p>
      ) : null}
    </aside>
  );
}
