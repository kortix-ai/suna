import React from 'react';
import { View, Modal } from 'react-native';
import { PricingSection } from './PricingSection';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/lib/billing';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { UnifiedPricingSection } from './UnifiedPricingSection';

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
      <View className="flex-1 bg-background">
        <UnifiedPricingSection
          returnUrl={returnUrl}
          showTitleAndTabs={true}
          insideDialog={true}
          noPadding={true}
          customTitle={creditsExhausted ? t('billing.ranOutOfCredits') : undefined}
          onSubscriptionUpdate={handleSubscriptionUpdate}
          onClose={handleClose}
        />
      </View>
    </Modal>
  );
}
