'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useReferralCode, useReferralStats } from '@/hooks/referrals/use-referrals';
import { useTranslations } from 'next-intl';
import { useReferralDialog } from '@/stores/referral-dialog';
import { ReferralCodeSection } from './referral-code-section';
import { ReferralStatsCards } from './referral-stats-cards';

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
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <p className="text-sm text-muted-foreground pt-2">
            {t('description')} <span className="font-semibold text-foreground">{t('creditsPerReferral')}</span>
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 pt-4">
          <ReferralCodeSection referralCode={referralCode} isLoading={codeLoading} />
          <ReferralStatsCards stats={stats} isLoading={statsLoading} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
