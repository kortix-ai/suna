'use client';

import { useLocale, useTranslations } from '../../../i18n';
import type { AccountSecretResource, SubscriptionConnection, SubscriptionUsage } from '@kortix/sdk';
import {
  useSubscriptionConnections,
  useSubscriptionUsage,
} from '@kortix/sdk/react';
import { ArrowClockwiseIcon, ChartBarIcon } from '@phosphor-icons/react';
import { usePooledProviderIds } from '../../providers/provider-connect';
import { Button } from '../../../primitives/button';
import { Badge } from '../../../primitives/badge';
import { EmptyState } from '../../../primitives/empty-state';
import Loading from '../../../primitives/loading';
import {
  useUiPathname,
  useUiSearchParams,
  useUiShallowNavigate,
} from '../../../providers/ui-provider';
import { ProviderLogo } from '../../../internal/lib/provider-branding';
import { Progress } from '../../../primitives/progress';
import {
  isSubscriptionLogin,
  shownUsage,
  formatReset,
  weeklyModel,
  usageTone,
} from './subscription-usage';

/** The props-only card also lets the design-system preview use synthetic data. */
export function SubscriptionUsageCard({
  secret,
  usage,
  fetching,
  error,
  onRefresh,
  onConnect,
}: {
  secret: AccountSecretResource;
  usage: SubscriptionUsage | null;
  fetching: boolean;
  error: boolean;
  onRefresh: () => void;
  onConnect?: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations('subscriptionUsage');
  const now = Date.now();
  const reconnect = Boolean(
    secret.needs_reauth_at || secret.status === 'undecryptable',
  );
  // A rejection in a snapshot whose reset has passed is no current limit.
  const rejectionIsCurrent = Boolean(
    usage?.limited &&
    !usage.windows.some(
      (window) => window.resets_at && Date.parse(window.resets_at) <= now,
    ),
  );
  const exhausted =
    rejectionIsCurrent ||
    Boolean(
      usage?.windows.some(
        (w) =>
          w.used_percent >= 100 &&
          (!w.resets_at || Date.parse(w.resets_at) > now),
      ),
    );
  const stale = Boolean(
    usage && now - Date.parse(usage.observed_at) > 10 * 60_000,
  );
  const status = reconnect
    ? t('text0')
    : !secret.active
      ? t('text1')
      : error
        ? t('text2')
        : !usage
          ? t('text3')
          : exhausted
            ? t('text4')
            : stale
              ? t('text5')
              : t('text6');
  return (
    <article className="rounded-md border border-border bg-card p-4 flex flex-col gap-4 min-w-0">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogo
            providerID={secret.provider_id ?? ''}
            size="large"
            tone="light"
          />
          <div className="min-w-0">
            <h3 className="text-base leading-6 font-medium">
              {secret.provider_id === 'codex' ? 'ChatGPT (Codex)' : 'Claude'}{' '}
              <span className="text-muted-foreground font-normal capitalize">
                {secret.provider_account?.plan ?? t('text7')}
              </span>
            </h3>
            <p
              className="text-sm leading-5 text-muted-foreground truncate"
              title={secret.label}
            >
              {secret.label}
            </p>
          </div>
        </div>
        <Badge
          size="sm"
          variant={reconnect || exhausted ? 'warning' : 'secondary'}
        >
          {status}
        </Badge>
      </header>
      <div className="space-y-4">
        {usage?.windows.length &&
        !usage.windows.some(
          (window) =>
            window.id === 'five_hour' || window.window_minutes === 300,
        ) ? (
          <p className="text-xs text-muted-foreground">
            {t('fiveHourNotReported')}
          </p>
        ) : null}
        {usage?.windows.length ? (
          usage.windows.map((window) => {
            const model = weeklyModel(window.id);
            const label =
              window.id === 'five_hour'
                ? t('fiveHour')
                : window.id === 'weekly'
                  ? t('weekly')
                  : model
                    ? t('weeklyModel', { model })
                    : window.id.replaceAll('_', ' ');
            const expired = Boolean(
              window.resets_at && Date.parse(window.resets_at) <= now,
            );
            const tone = usageTone(window, usage.limited);
            const percent = Math.max(
              0,
              Math.min(100, Math.round(window.used_percent)),
            );
            return (
              <div key={window.id} className="space-y-2">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>{label}</span>
                  <span className="tabular-nums font-medium">
                    {percent}%{' '}
                    <span className="font-normal text-muted-foreground">
                      {t('text8')}
                    </span>
                  </span>
                </div>
                <Progress
                  value={percent}
                  aria-label={t('meterLabel', { label, percent })}
                  className="h-1.5 bg-muted"
                  indicatorClassName={
                    expired
                      ? 'bg-muted-foreground'
                      : tone === 'limited' || tone === 'critical'
                        ? 'bg-kortix-red'
                        : tone === 'near'
                          ? 'bg-kortix-orange'
                          : 'bg-primary'
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {expired
                    ? t('text9')
                    : window.resets_at
                      ? t('resets', {
                          time: formatReset(window.resets_at, now, locale),
                        })
                      : t('text10')}
                </p>
                {model === 'Fable' && (
                  <p className="text-xs text-muted-foreground">
                    {t('fableIncluded')}
                  </p>
                )}
              </div>
            );
          })
        ) : (
          <p className="text-sm text-muted-foreground py-3">
            {fetching ? t('text11') : t('text12')}
          </p>
        )}
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">
          {error
            ? usage
              ? t('text13')
              : t('text2')
            : usage
              ? t('observed', {
                  time: new Date(usage.observed_at).toLocaleString(locale, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  }),
                })
              : t('text14')}
        </p>
        {reconnect ? (
          <Button variant="outline" size="sm" onClick={onConnect}>
            {t('reconnect')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={fetching || !secret.active}
            onClick={onRefresh}
            aria-label={t('refreshLabel', { label: secret.label })}
          >
            <ArrowClockwiseIcon />
            {fetching ? t('text15') : t('text16')}
          </Button>
        )}
      </footer>
    </article>
  );
}

function ConnectedSubscription({
  accountId,
  projectId,
  secret,
  onConnect,
}: {
  accountId: string;
  projectId: string;
  secret: SubscriptionConnection;
  onConnect: () => void;
}) {
  const live = useSubscriptionUsage(accountId, secret.secret_id, {
    projectId,
    storage: secret.storage,
    enabled:
      secret.can_use &&
      secret.active &&
      !secret.needs_reauth_at &&
      secret.status !== 'undecryptable',
  });
  return (
    <SubscriptionUsageCard
      secret={{
        ...secret,
        provider_account:
          live.data?.provider_account ?? secret.provider_account,
      }}
      usage={shownUsage(live.data?.usage, secret.usage)}
      fetching={live.isFetching}
      error={live.isError}
      onRefresh={() => void live.refetch()}
      onConnect={onConnect}
    />
  );
}

export function SubscriptionUsageTab({
  projectId,
  onConnect,
}: {
  projectId: string;
  onConnect: () => void;
}) {
  const t = useTranslations('subscriptionUsage');
  const searchParams = useUiSearchParams();
  const pathname = useUiPathname();
  const navigate = useUiShallowNavigate();
  const requestedProvider = searchParams.get('provider');
  const provider =
    requestedProvider === 'codex' || requestedProvider === 'claude-agent'
      ? requestedProvider
      : null;
  const pooled = usePooledProviderIds(projectId, true);
  const resources = useSubscriptionConnections(pooled.accountId, projectId);
  const subscriptions = (resources.data?.subscriptions ?? []).filter(
    (secret) =>
      secret.can_use &&
      isSubscriptionLogin(secret) &&
      (!provider || secret.provider_id === provider),
  );
  return (
    <section className="@container space-y-6 pb-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">
          {provider === 'codex'
            ? t('chatgptUsage')
            : provider === 'claude-agent'
              ? t('claudeUsage')
              : t('text17')}
        </h2>
        {provider && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const params = new URLSearchParams(searchParams.toString());
              params.delete('provider');
              navigate(`${pathname}?${params}`, { replace: true });
            }}
          >
            {t('allSubscriptions')}
          </Button>
        )}
        <p className="text-sm text-muted-foreground">{t('text18')}</p>
      </div>
      {pooled.isLoading || (pooled.accountId && resources.isLoading) ? (
        <Loading />
      ) : pooled.isError || resources.isError ? (
        <EmptyState
          title={t('text19')}
          description={t('text20')}
          action={
            <Button
              variant="outline"
              onClick={() => {
                void pooled.refetch();
                void resources.refetch();
              }}
            >
              {t('text21')}
            </Button>
          }
        />
      ) : !pooled.pooledSecretsEnabled ? (
        <EmptyState
          icon={ChartBarIcon}
          title={t('disabledTitle')}
          description={t('disabledDescription')}
        />
      ) : !subscriptions.length ? (
        <EmptyState
          icon={ChartBarIcon}
          title={t('text22')}
          description={t('text23')}
          action={
            <Button variant="outline" onClick={onConnect}>
              {t('text24')}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-flow-dense grid-cols-1 @3xl:grid-cols-2 items-start gap-4">
          {subscriptions.map((secret) => (
            <ConnectedSubscription
              projectId={projectId}
              key={`${secret.storage}:${secret.secret_id}`}
              accountId={pooled.accountId!}
              secret={secret}
              onConnect={onConnect}
            />
          ))}
        </div>
      )}
      <div className="text-xs text-muted-foreground space-y-1 border-t border-border pt-3">
        <p>{t('text25')}</p>
        <p>{t('text26')}</p>
      </div>
    </section>
  );
}
