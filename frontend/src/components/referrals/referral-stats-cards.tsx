'use client';

import { Users, Coins } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface ReferralStatsCardsProps {
  stats?: {
    total_referrals: number;
    successful_referrals: number;
    total_credits_earned: number;
  };
  isLoading?: boolean;
  compact?: boolean;
}

export function ReferralStatsCards({ stats, isLoading, compact = false }: ReferralStatsCardsProps) {
  const t = useTranslations('settings.referrals');

  if (isLoading) {
    return (
      <div className={cn(
        "grid gap-3",
        compact ? "grid-cols-2" : "grid-cols-1 md:grid-cols-2"
      )}>
        <div className="p-3 rounded-lg border border-border bg-muted/30">
          <Skeleton className="h-3 w-20 mb-2" />
          <Skeleton className="h-6 w-12" />
        </div>
        <div className="p-3 rounded-lg border border-border bg-muted/30">
          <Skeleton className="h-3 w-24 mb-2" />
          <Skeleton className="h-6 w-16" />
        </div>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-lg border border-border bg-muted/30">
          <div className="flex items-center gap-1.5 mb-1">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{t('stats.totalReferrals')}</span>
          </div>
          <p className="text-xl font-semibold">{stats?.total_referrals || 0}</p>
        </div>
        <div className="p-3 rounded-lg border border-border bg-muted/30">
          <div className="flex items-center gap-1.5 mb-1">
            <Coins className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{t('stats.creditsEarned')}</span>
          </div>
          <p className="text-xl font-semibold">
            {Math.round(stats?.total_credits_earned || 0).toLocaleString()}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="p-4 rounded-lg border border-border bg-muted/30">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-muted border border-border">
            <Users className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-2xl font-semibold">
              {stats?.total_referrals || 0}
            </p>
            <p className="text-xs sm:text-sm text-muted-foreground">{t('stats.totalReferrals')}</p>
          </div>
        </div>
      </div>
      <div className="p-4 rounded-lg border border-border bg-muted/30">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-muted border border-border">
            <Coins className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-2xl font-semibold">
              {Math.round(stats?.total_credits_earned || 0).toLocaleString()}
            </p>
            <p className="text-xs sm:text-sm text-muted-foreground">{t('stats.creditsEarned')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
