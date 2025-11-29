import { Card, CardContent } from '@/components/ui/card';
import { Users, Coins } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

interface ReferralStatsCardsProps {
  stats?: {
    total_referrals: number;
    successful_referrals: number;
    total_credits_earned: number;
  };
  isLoading?: boolean;
}

export function ReferralStatsCards({ stats, isLoading }: ReferralStatsCardsProps) {
  const t = useTranslations('settings.referrals');

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent>
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardContent>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-muted border">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {stats?.total_referrals || 0}
              </p>
              <p className="text-sm text-muted-foreground">{t('stats.totalReferrals')}</p>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-muted border">
              <Coins className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {Math.round(stats?.total_credits_earned || 0).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground">{t('stats.creditsEarned')}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
