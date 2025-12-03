'use client';

import * as React from 'react';
import { useReferralCode, useReferralStats } from '@/hooks/referrals/use-referrals';
import { useTranslations } from 'next-intl';
import { ReferralCodeSection } from './referral-code-section';
import { ReferralStatsCards } from './referral-stats-cards';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ReferralEmailInvitation } from './referral-email-invitation';

export function ReferralsTab() {
  const t = useTranslations('settings.referrals');
  const { data: referralCode, isLoading: codeLoading } = useReferralCode();
  const { data: stats, isLoading: statsLoading } = useReferralStats();

  return (
    <div className="p-4 sm:p-6 space-y-6 min-w-0 max-w-full overflow-x-hidden">
      {/* Header */}
      <div className="flex flex-col items-center text-center mb-4 sm:mb-6">
        <div className="mb-2 sm:mb-4 p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-muted/50">
          <KortixLogo size={24} variant="symbol" className="sm:hidden" />
          <KortixLogo size={32} variant="symbol" className="hidden sm:block" />
        </div>
        <h2 className="text-lg sm:text-xl font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2">
          {t('description')} <span className="font-semibold text-foreground">{t('creditsPerReferral')}</span>
        </p>
      </div>

      {/* Credit Info */}
      <div className="bg-muted/30 rounded-lg sm:rounded-xl p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground mb-1">{t('youEarn')}</p>
            <p className="text-xl font-semibold">{t('creditsPerReferral')}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground mb-1">{t('friendGets')}</p>
            <p className="text-xl font-semibold">{t('creditsPerReferral')}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
          {t('maxEarnable')} <span className="font-semibold text-foreground">{t('maxCredits')}</span>
        </p>
      </div>

      {/* Share Section */}
      <div>
        <h3 className="text-sm font-medium mb-3">{t('shareYourLink')}</h3>
        <ReferralCodeSection referralCode={referralCode} isLoading={codeLoading} />
      </div>

      <div>
        <ReferralEmailInvitation />
      </div>

      {/* Stats Section */}
      <div>
        <h3 className="text-sm font-medium mb-3">{t('yourStats')}</h3>
        <ReferralStatsCards stats={stats} isLoading={statsLoading} />
      </div>
    </div>
  );
}
