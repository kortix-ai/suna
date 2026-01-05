'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { useReferralCode, useReferralStats } from '@/hooks/referrals/use-referrals';
import { useTranslations } from 'next-intl';
import { useReferralDialog } from '@/stores/referral-dialog';
import { ReferralCodeSection } from './referral-code-section';
import { ReferralStatsCards } from './referral-stats-cards';
import { ReferralEmailInvitation } from './referral-email-invitation';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Handshake } from 'lucide-react';

interface ReferralDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ReferralDialog({ open: controlledOpen, onOpenChange: controlledOnOpenChange }: ReferralDialogProps) {
  const t = useTranslations('settings.referrals');
  const storeState = useReferralDialog();
  const open = controlledOpen ?? storeState.isOpen;
  const onOpenChange = controlledOnOpenChange ?? ((isOpen: boolean) => isOpen ? storeState.openDialog() : storeState.closeDialog());
  
  const { data: referralCode, isLoading: codeLoading } = useReferralCode();
  const { data: stats, isLoading: statsLoading } = useReferralStats();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 overflow-hidden max-h-[90vh] sm:max-h-[85vh]">
        <div className="p-4 sm:p-6 overflow-y-auto max-h-[85vh] sm:max-h-none">
          {/* Logo & Header */}
          <div className="flex flex-col items-center text-center mb-3 sm:mb-5">
            <div className="mb-6">
              <KortixLogo size={24} variant="symbol" />
            </div>
            <DialogTitle className="text-base sm:text-xl font-semibold text-foreground">
              {t('title')}
            </DialogTitle>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-2 px-2">
              {t('description')}
            </p>
          </div>

          {/* Credit Info */}
          <div className="bg-muted/30 rounded-lg sm:rounded-xl p-6 mb-3 sm:mb-5 border border-border/50">
            <div className="flex items-center justify-between gap-4 sm:gap-6">
              <div className="flex-1 flex flex-col items-start">
                <p className="text-xs sm:text-sm text-muted-foreground mb-2">{t('youEarn')}</p>
                <p className="text-xl sm:text-2xl font-semibold text-foreground">{t('creditsPerReferral')}</p>
              </div>
              <div className="flex-shrink-0">
                <Handshake className="h-5 w-5 sm:h-6 sm:w-6 text-muted-foreground" />
              </div>
              <div className="flex-1 flex flex-col items-end">
                <p className="text-xs sm:text-sm text-muted-foreground mb-2">{t('friendGets')}</p>
                <p className="text-xl sm:text-2xl font-semibold text-foreground">{t('creditsPerReferral')}</p>
              </div>
            </div>
          </div>
          <div className="mb-3 sm:mb-4">
            <ReferralCodeSection referralCode={referralCode} isLoading={codeLoading} />
          </div>
          
          <div className="mb-3 sm:mb-4">
            <ReferralEmailInvitation />
          </div>
          
          <ReferralStatsCards stats={stats} isLoading={statsLoading} compact />
        </div>
      </DialogContent>
    </Dialog>
  );
}
