import React from 'react';
import { Modal } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/lib/billing';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { PlanPage } from '@/components/settings/PlanPage';

interface PlanSelectionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnUrl?: string;
  creditsExhausted?: boolean;
}

export function PlanSelectionModal({
  open,
  onOpenChange,
  returnUrl,
  creditsExhausted = false,
}: PlanSelectionModalProps) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onOpenChange(false);
  };

  const handleSubscriptionUpdate = () => {
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    setTimeout(() => {
      onOpenChange(false);
    }, 500);
  };

  if (!open) return null;

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
    >
      <PlanPage
        visible={true}
        onClose={handleClose}
        onPurchaseComplete={handleSubscriptionUpdate}
        customTitle={creditsExhausted ? t('billing.ranOutOfCredits') : undefined}
      />
    </Modal>
  );
}
