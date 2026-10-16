'use client';

/**
 * The Enterprise features (SSO, SCIM, advanced roles, audit logs, branding)
 * and their state (.agents/skills/billing/references/plans-and-access.md):
 *
 *   - Off: a billing manager turns on the demo; anyone may talk to sales.
 *   - Demo: on, self-serve. A billing manager turns it off.
 *   - Licensed: on through a license contract.
 *
 * Enterprise never changes the billing plan. Renders a bare `SettingsRow`:
 * mount it inside a `SettingsRowGroup`.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { SettingsRow } from '@/components/ui/settings-row';
import { useEnterpriseDemo, useTalkToSales } from '@/features/billing/use-enterprise-sales';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { canManageBilling, type AccountState } from '@kortix/sdk';

function formatDay(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
}

export function EnterpriseAccessRow({ state, accountId }: { state: AccountState; accountId?: string }) {
  const t = useTranslations('billing.access');
  const locale = useLocale();
  const sales = useTalkToSales(accountId);
  const demo = useEnterpriseDemo(accountId);
  const enterprise = state.enterprise?.state ?? 'off';
  const manager = canManageBilling(state) && !!accountId;
  const { contract, grace } = state;

  const description =
    enterprise === 'licensed'
      ? contract?.ends_at
        ? contract.renews
          ? t('featuresLicensedRenews', { date: formatDay(contract.ends_at, locale) })
          : t('featuresLicensedUntil', { date: formatDay(contract.ends_at, locale) })
        : t('featuresLicensed')
      : enterprise === 'demo'
        ? t('featuresDemo')
        : grace
          ? t('featuresGrace', { date: formatDay(grace.ends_at, locale) })
          : t('featuresOffDescription');

  return (
    <SettingsRow label={t('featuresLabel')} description={description}>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <Badge
          variant={enterprise === 'licensed' ? 'success' : enterprise === 'demo' ? 'info' : 'muted'}
          size="sm"
        >
          {enterprise === 'licensed'
            ? t('featuresOn')
            : enterprise === 'demo'
              ? t('featuresDemoBadge')
              : t('featuresOff')}
        </Badge>
        {manager && enterprise !== 'licensed' ? (
          <Button
            size="sm"
            variant={enterprise === 'demo' ? 'ghost' : 'default'}
            className="gap-1.5"
            disabled={demo.isPending}
            onClick={() => demo.set(enterprise !== 'demo')}
          >
            {demo.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {enterprise === 'demo' ? t('demoTurnOff') : t('demoTurnOn')}
          </Button>
        ) : null}
        {enterprise === 'licensed' ? null : (
          <Button size="sm" variant="outline" disabled={sales.isPending} onClick={sales.talk}>
            {t('talkToSales')}
          </Button>
        )}
      </span>
    </SettingsRow>
  );
}
