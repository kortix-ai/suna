'use client';

import { Handshake } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalTitle,
} from '@/components/ui/modal';
import { useReferralCode, useReferralStats } from '@/hooks/referrals/use-referrals';
import { useReferralDialog } from '@/stores/referral-dialog';

import { ReferralCodeSection } from './referral-code-section';
import { ReferralEmailInvitation } from './referral-email-invitation';
import { ReferralStatsCards } from './referral-stats-cards';

interface ReferralModalProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ReferralModal({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: ReferralModalProps) {
  const t = useTranslations('settings.referrals');
  const storeState = useReferralDialog();
  const open = controlledOpen ?? storeState.isOpen;
  const onOpenChange =
    controlledOnOpenChange ??
    ((isOpen: boolean) => (isOpen ? storeState.openDialog() : storeState.closeDialog()));

  const { data: referralCode, isLoading: codeLoading } = useReferralCode({ enabled: open });
  const { data: stats, isLoading: statsLoading } = useReferralStats({ enabled: open });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-h-[90vh] lg:max-h-[85vh] lg:max-w-2xl">
        <ModalBody className="max-h-[85vh] overflow-y-auto pt-5 lg:max-h-none">
          <div className="mb-3 flex flex-col items-center text-center sm:mb-5">
            <div className="mb-6">
              <KortixLogo size={24} variant="symbol" />
            </div>
            <ModalTitle className="text-base font-semibold sm:text-xl">{t('title')}</ModalTitle>
            <ModalDescription className="mt-1 px-2 text-xs sm:mt-2 sm:text-sm">
              {t('description')}
            </ModalDescription>
          </div>

          <div className="bg-muted/30 border-border/50 mb-3 rounded-2xl border p-6 sm:mb-5">
            <div className="flex items-center justify-between gap-4 sm:gap-6">
              <div className="flex flex-1 flex-col items-start">
                <p className="text-muted-foreground mb-2 text-xs sm:text-sm">{t('youEarn')}</p>
                <p className="text-foreground text-xl font-semibold sm:text-2xl">
                  {t('creditsPerReferral')}
                </p>
              </div>
              <div className="shrink-0">
                <Handshake className="text-muted-foreground h-5 w-5 sm:h-6 sm:w-6" />
              </div>
              <div className="flex flex-1 flex-col items-end">
                <p className="text-muted-foreground mb-2 text-xs sm:text-sm">{t('friendGets')}</p>
                <p className="text-foreground text-xl font-semibold sm:text-2xl">
                  {t('creditsPerReferral')}
                </p>
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
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
