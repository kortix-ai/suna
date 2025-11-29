import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Copy, Share2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useRefreshReferralCode } from '@/hooks/referrals/use-referrals';

interface ReferralCodeSectionProps {
  referralCode?: {
    referral_code: string;
    referral_url: string;
  };
  isLoading?: boolean;
}

export function ReferralCodeSection({ referralCode, isLoading }: ReferralCodeSectionProps) {
  const t = useTranslations('settings.referrals');
  const refreshMutation = useRefreshReferralCode();

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t(label === 'Referral code' ? 'codeCopied' : 'linkCopied'));
    } catch (error) {
      console.error('Failed to copy:', error);
      toast.error('Failed to copy');
    }
  };

  const shareReferralLink = async () => {
    if (!referralCode?.referral_url) return;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join Kortix with my referral link',
          text: 'Get started with Kortix using my referral link!',
          url: referralCode.referral_url,
        });
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('Error sharing:', error);
        }
      }
    } else {
      copyToClipboard(referralCode.referral_url, 'Referral link');
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div>
          <Skeleton className="h-4 w-32 mb-2" />
          <div className="flex gap-2">
            <Skeleton className="h-10 flex-1" />
            <Skeleton className="h-10 w-10" />
          </div>
        </div>
        <div>
          <Skeleton className="h-4 w-24 mb-2" />
          <div className="flex gap-2">
            <Skeleton className="h-10 flex-1" />
            <Skeleton className="h-10 w-10" />
            <Skeleton className="h-10 w-10" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-muted-foreground">{t('yourReferralCode')}</label>
        </div>
        <div className="flex gap-2 h-11.5">
          <Input
            value={referralCode?.referral_code || ''}
            readOnly
            className="font-mono text-base font-semibold focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Button
            variant="outline"
            className='h-full aspect-square'
            onClick={() => copyToClipboard(referralCode?.referral_code || '', 'Referral code')}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className='h-full aspect-square'
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            <RotateCcw className={`h-3 w-3 ${refreshMutation.isPending ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div>
        <label className="text-xs text-muted-foreground mb-2 block">{t('referralLink')}</label>
        <div className="flex gap-2 h-11.5">
          <Input
            value={referralCode?.referral_url || ''}
            readOnly
            className="text-sm"
          />
          <Button
            variant="outline"
            className='h-full aspect-square'
            onClick={() => copyToClipboard(referralCode?.referral_url || '', 'Referral link')}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            variant="default"
            className='h-full aspect-square'
            onClick={shareReferralLink}
          >
            <Share2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
