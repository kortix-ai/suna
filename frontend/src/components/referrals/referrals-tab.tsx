'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useReferralCode, useReferralStats } from '@/hooks/referrals/use-referrals';
import { useTranslations } from 'next-intl';
import { ReferralCodeSection } from './referral-code-section';
import { ReferralStatsCards } from './referral-stats-cards';

export function ReferralsTab() {
  const t = useTranslations('settings.referrals');
  const { data: referralCode, isLoading: codeLoading } = useReferralCode();
  const { data: stats, isLoading: statsLoading } = useReferralStats();

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('description')} <span className="font-semibold text-foreground">{t('creditsPerReferral')}</span>!
          </p>
          <p className="text-xs text-muted-foreground">
            {t('maxEarnable')} <span className="font-semibold text-foreground">{t('maxCredits')}</span>
          </p>

          <ReferralCodeSection referralCode={referralCode} isLoading={codeLoading} />
        </CardContent>
      </Card>

      <ReferralStatsCards stats={stats} isLoading={statsLoading} />
    </div>
  );
}

