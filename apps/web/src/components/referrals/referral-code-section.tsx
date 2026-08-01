'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast';
import { copyToClipboard } from '@/lib/utils/clipboard';
import {
  CheckIcon as Check,
  CopyIcon as Copy,
  ShareNetworkIcon as Share2,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
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

  const handleCopy = async (text: string) => {
    if (await copyToClipboard(text)) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
      toast.success(t('linkCopied'));
    } else {
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
      handleCopy(referralCode.referral_url);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="mb-2 h-4 w-24" />
        <div className="flex gap-2">
          <Skeleton className="h-10 flex-1 rounded-2xl" />
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-10 w-16 rounded-full sm:w-20" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-foreground mb-2 block text-xs font-medium sm:text-sm">
          {t('referralLink')}
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type="text"
              value={referralCode?.referral_url || ''}
              readOnly
              className="pr-10 font-mono text-xs sm:text-sm"
            />
            <div
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 cursor-pointer transition-colors"
              onClick={() => handleCopy(referralCode?.referral_url || '')}
            >
              {copiedLink ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </div>
          </div>
          <Button
            variant="default"
            className="h-10 w-[72px] flex-shrink-0 px-2 sm:w-auto sm:px-3"
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
