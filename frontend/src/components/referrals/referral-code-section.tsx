'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Copy, Share2, RotateCcw, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useRefreshReferralCode } from '@/hooks/referrals/use-referrals';
import { useState } from 'react';
import { cn } from '@/lib/utils';

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
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const copyToClipboard = async (text: string, type: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === 'link') {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      } else {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 2000);
      }
      toast.success(type === 'link' ? t('linkCopied') : t('codeCopied'));
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
          text: 'Get 400 free credits when you sign up with my referral link!',
          url: referralCode.referral_url,
        });
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('Error sharing:', error);
        }
      }
    } else {
      copyToClipboard(referralCode.referral_url, 'link');
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-24 mb-2" />
        <div className="flex gap-2">
          <Skeleton className="h-10 flex-1 rounded-lg" />
          <Skeleton className="h-10 w-10 rounded-lg" />
          <Skeleton className="h-10 w-16 sm:w-20 rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs sm:text-sm font-medium text-foreground mb-2 block">
          {t('referralLink')}
        </label>
        <div className="flex gap-2">
          <Input
            value={referralCode?.referral_url || ''}
            readOnly
            className="text-xs sm:text-sm font-mono flex-1 min-w-0"
          />
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 flex-shrink-0"
            onClick={() => copyToClipboard(referralCode?.referral_url || '', 'link')}
          >
            {copiedLink ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="default"
            className="h-10 px-2 sm:px-3 flex-shrink-0"
            onClick={shareReferralLink}
          >
            <Share2 className="h-4 w-4 sm:mr-1.5" />
            <span className="hidden sm:inline">{t('share')}</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {t('yourReferralCode')}: <span className="font-mono font-semibold text-foreground">{referralCode?.referral_code || ''}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            <RotateCcw className={cn("h-3 w-3 mr-1", refreshMutation.isPending && "animate-spin")} />
            {t('refresh')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => copyToClipboard(referralCode?.referral_code || '', 'code')}
          >
            {copiedCode ? (
              <Check className="h-3 w-3 mr-1" />
            ) : (
              <Copy className="h-3 w-3 mr-1" />
            )}
            {t('copyCode')}
          </Button>
        </div>
      </div>
    </div>
  );
}
