'use client';

/**
 * Whether the account has the Enterprise features (SSO, SCIM, advanced roles,
 * audit logs), and why: the Enterprise plan through a contract or a trial, or
 * the grace after it ended. Replaces the retired Enterprise preview toggle:
 * the plan decides (.agents/skills/billing/references/plans-and-access.md).
 *
 * Renders a bare `SettingsRow`: mount it inside a `SettingsRowGroup`.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SettingsRow } from '@/components/ui/settings-row';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { resolvedPlan, type AccountState } from '@kortix/sdk';

function formatDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
}

export function EnterpriseAccessRow({ state }: { state: AccountState }) {
  const t = useTranslations('billing.access');
  const locale = useLocale();
  const openDemo = useRequestDemo();
  const onEnterprise = resolvedPlan(state).family === 'enterprise';
  const { trial, grace } = state;

  const description = onEnterprise
    ? trial
      ? t('featuresTrial', { date: formatDay(trial.ends_at, locale) })
      : t('featuresContract')
    : grace
      ? t('featuresGrace', { date: formatDay(grace.ends_at, locale) })
      : t('featuresNotOnPlan');

  return (
    <SettingsRow label={t('featuresLabel')} description={description}>
      <span className="flex shrink-0 items-center gap-2">
        <Badge variant={onEnterprise ? 'success' : 'muted'} size="sm">
          {onEnterprise ? t('featuresOn') : t('featuresOff')}
        </Badge>
        {onEnterprise && !trial ? null : (
          <Button variant="outline" size="sm" onClick={() => openDemo({ source: 'accounts-enterprise-access' })}>
            {t('talkToSales')}
          </Button>
        )}
      </span>
    </SettingsRow>
  );
}
