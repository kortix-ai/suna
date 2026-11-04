'use client';

import type { AccountSecretResource, SubscriptionUsage, SubscriptionUsageWindow } from '@kortix/sdk';
import { useSubscriptionUsage } from '@kortix/sdk/react';
import { useLocale, useTranslations } from '../../../i18n';
import { Progress } from '../../../primitives/progress';

/** Providers whose stored value is a subscription login with plan windows. */
const SUBSCRIPTION_PROVIDERS = new Set(['codex', 'claude-agent']);

/** A snapshot older than this says when it was observed. */
const STALE_MS = 10 * 60 * 1000;

export type UsageTone = 'ok' | 'near' | 'limited';

/** Bar color by state: the storage meter's thresholds, red once the provider refuses. */
export function usageTone(window: SubscriptionUsageWindow, limited: boolean): UsageTone {
  if (window.used_percent >= 100 || (limited && window.used_percent >= 90)) return 'limited';
  return window.used_percent >= 90 ? 'near' : 'ok';
}

const TONE_BAR: Record<UsageTone, string> = { ok: 'bg-primary', near: 'bg-kortix-orange', limited: 'bg-kortix-red' };

/** The model name of a model-specific weekly window (`seven_day_opus` → `Opus`), or null. */
export function weeklyModel(id: string): string | null {
  const model = /^(?:seven_day|7d)_([a-z]+)$/.exec(id)?.[1];
  return model ? model[0]!.toUpperCase() + model.slice(1) : null;
}

/**
 * A reset time a person reads at a glance: the clock time today, the weekday
 * and time within a week, else the date.
 */
export function formatReset(iso: string, now: number, locale: string): string {
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return '';
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay ? { hour: 'numeric', minute: '2-digit' }
    : ms < 6 * 24 * 60 * 60 * 1000 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, options).format(at);
}

/** The usage to show: the live read when it answered, else the snapshot the list carried. */
export function shownUsage(live: SubscriptionUsage | null | undefined, listed: SubscriptionUsage | null | undefined): SubscriptionUsage | null {
  if (live && listed) return Date.parse(live.observed_at) >= Date.parse(listed.observed_at) ? live : listed;
  return live ?? listed ?? null;
}

export function isSubscriptionLogin(secret: Pick<AccountSecretResource, 'provider_id'>): boolean {
  return Boolean(secret.provider_id && SUBSCRIPTION_PROVIDERS.has(secret.provider_id));
}

function UsageWindowMeter({ window, limited, now }: { window: SubscriptionUsageWindow; limited: boolean; now: number }) {
  const t = useTranslations('pooledSecrets');
  const locale = useLocale();
  const model = weeklyModel(window.id);
  const label = window.id === 'five_hour' ? t('usageFiveHour')
    : window.id === 'weekly' ? t('usageWeekly')
      : model ? t('usageWeeklyModel', { model }) : window.id;
  const tone = usageTone(window, limited);
  const percent = Math.round(window.used_percent);
  const reset = window.resets_at && Date.parse(window.resets_at) > now ? formatReset(window.resets_at, now, locale) : null;
  const detail = tone === 'limited'
    ? reset ? t('usageLimitResets', { time: reset }) : t('usageLimitReached')
    : reset ? t('usagePercentResets', { percent, time: reset }) : t('usagePercent', { percent });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground shrink-0">{label}</span>
        <span className={tone === 'limited' ? 'text-foreground min-w-0 truncate tabular-nums' : 'text-muted-foreground min-w-0 truncate tabular-nums'}>{detail}</span>
      </div>
      <Progress
        value={Math.min(100, window.used_percent)}
        aria-label={t('usageAriaLabel', { window: label, percent })}
        className="bg-muted h-1"
        indicatorClassName={TONE_BAR[tone]}
      />
    </div>
  );
}

/**
 * The plan usage of one ChatGPT or Claude login, under its name in the account
 * list: one bar per window (5-hour, weekly, a model's weekly), each with its
 * reset time. It shows the snapshot the list carried at once and asks the
 * server for a fresh read every minute while it is on screen.
 */
export function SubscriptionUsageMeters({ accountId, secret }: { accountId: string; secret: AccountSecretResource }) {
  const t = useTranslations('pooledSecrets');
  const locale = useLocale();
  const live = useSubscriptionUsage(accountId, secret.secret_id, { enabled: isSubscriptionLogin(secret) });
  const usage = shownUsage(live.data?.usage, secret.usage);
  const now = Math.max(Date.now(), live.dataUpdatedAt);
  if (!usage) {
    // Nothing to say while the first read runs; after it, say when numbers appear.
    return live.isFetching ? null : <span className="text-muted-foreground block text-xs font-normal">{t('usageNotSeen')}</span>;
  }
  const observed = Date.parse(usage.observed_at);
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 font-normal">
      {usage.windows.map((window) => <UsageWindowMeter key={window.id} window={window} limited={usage.limited} now={now} />)}
      {now - observed > STALE_MS && (
        <span className="text-muted-foreground text-xs">{t('usageObserved', { time: formatReset(usage.observed_at, now, locale) })}</span>
      )}
    </div>
  );
}
