'use client';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { CoinsIcon as Coins, UsersIcon as Users } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';

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
      <div className={cn('grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-1 md:grid-cols-2')}>
        <Card className="bg-muted/30 gap-0 p-6">
          <Skeleton className="mb-2 h-3 w-20" />
          <Skeleton className="h-6 w-12" />
        </Card>
        <Card className="bg-muted/30 gap-0 p-6">
          <Skeleton className="mb-2 h-3 w-24" />
          <Skeleton className="h-6 w-16" />
        </Card>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="grid grid-cols-2 gap-3">
        <Card className="bg-muted/30 gap-0 p-6">
          <div className="mb-1 flex items-center gap-1.5">
            <Users className="text-muted-foreground h-3.5 w-3.5" />
            <span className="text-muted-foreground text-xs">{t('stats.totalReferrals')}</span>
          </div>
          <p className="text-xl font-semibold">{stats?.total_referrals || 0}</p>
        </Card>
        <Card className="bg-muted/30 gap-0 p-6">
          <div className="mb-1 flex items-center gap-1.5">
            <Coins className="text-muted-foreground h-3.5 w-3.5" />
            <span className="text-muted-foreground text-xs">{t('stats.creditsEarned')}</span>
          </div>
          <p className="text-xl font-semibold">
            {Math.round(stats?.total_credits_earned || 0).toLocaleString()}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card className="bg-muted/30 gap-0 p-6">
        <div className="flex items-center gap-3">
          <div className="bg-muted border-border rounded-2xl border p-2">
            <Users className="text-muted-foreground h-4 w-4" />
          </div>
          <div>
            <p className="text-2xl font-semibold">{stats?.total_referrals || 0}</p>
            <p className="text-muted-foreground text-xs sm:text-sm">{t('stats.totalReferrals')}</p>
          </div>
        </div>
      </Card>
      <Card className="bg-muted/30 gap-0 p-6">
        <div className="flex items-center gap-3">
          <div className="bg-muted border-border rounded-2xl border p-2">
            <Coins className="text-muted-foreground h-4 w-4" />
          </div>
          <div>
            <p className="text-2xl font-semibold">
              {Math.round(stats?.total_credits_earned || 0).toLocaleString()}
            </p>
            <p className="text-muted-foreground text-xs sm:text-sm">{t('stats.creditsEarned')}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
