'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Copy, Share2, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useState } from 'react';

interface ReferralCodeSectionProps {
  referralCode?: {
    referral_code: string;
    referral_url: string;
  };
  isLoading?: boolean;
}

export function ReferralCodeSection({ referralCode, isLoading }: ReferralCodeSectionProps) {
  const t = useTranslations('settings.referrals');
  const [copiedLink, setCopiedLink] = useState(false);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
      toast.success(t('linkCopied'));
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
      copyToClipboard(referralCode.referral_url);
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
          <div className="relative flex-1">
            <Input
              value={referralCode?.referral_url || ''}
              readOnly
              className="text-xs sm:text-sm font-mono pr-10"
            />
            <div
              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => copyToClipboard(referralCode?.referral_url || '')}
            >
              {copiedLink ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </div>
          </div>
          <Button
            variant="default"
            className="h-10 px-2 sm:px-3 flex-shrink-0 w-[72px] sm:w-auto"
            onClick={shareReferralLink}
          >
            <Share2 className="h-4 w-4 sm:mr-1.5" />
            <span className="hidden sm:inline">{t('share')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
