/**
 * Billing Modal Component
 *
 * Full-screen modal for billing/plan selection
 * Automatically shows when user needs subscription
 */

import React from 'react';
import { View, Pressable, Modal, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X } from 'lucide-react-native';
import { BillingContent } from './BillingContent';
import { useBillingContext } from '@/contexts/BillingContext';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

interface BillingModalProps {
  visible: boolean;
  onDismiss: () => void;
  canDismiss?: boolean;
  onSuccess?: () => void;
}

export function BillingModal({
  visible,
  onDismiss,
  canDismiss = true,
  onSuccess,
}: BillingModalProps) {
  const { t } = useLanguage();
  const { trialStatus } = useBillingContext();

  const canStartTrial = trialStatus?.can_start_trial ?? false;

  const handleClose = () => {
    if (canDismiss) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onDismiss();
    }
  };

  const handleSuccess = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onSuccess?.();
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View className="flex-1 bg-background">
        {/* Header */}
        <View className="flex-row items-center justify-between px-6 py-4 border-b border-border">
          <Text className="text-xl font-roobert-semibold text-foreground">
            {canStartTrial ? t('billing.upgradeTitle', 'Choose Your Plan') : t('billing.subscriptionRequired', 'Subscription Required')}
          </Text>
          {canDismiss && (
            <Pressable
              onPress={handleClose}
              className="w-8 h-8 items-center justify-center rounded-full bg-secondary"
            >
              <Icon as={X} size={20} className="text-muted-foreground" strokeWidth={2} />
            </Pressable>
          )}
        </View>

        {/* Content */}
        <View className="flex-1">
          <BillingContent
            canStartTrial={canStartTrial}
            onSuccess={handleSuccess}
            onCancel={handleClose}
            simplified={false}
            showFreeTier={true}
            t={(key: string, defaultValue?: string) => t(key, defaultValue || '')}
          />
        </View>

        {/* Footer message for non-dismissible modal */}
        {!canDismiss && (
          <View className="px-6 py-4 bg-destructive/5 border-t border-destructive/20">
            <Text className="text-sm text-destructive text-center">
              {t('billing.insufficientCredits', 'You\'ve run out of credits. Please choose a plan to continue.')}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
