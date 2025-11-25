/**
 * Billing Page Component
 * 
 * Matches frontend's billing tab design exactly
 * Uses hooks directly like frontend (no context)
 */

import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AlertTriangle } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { PricingSection } from '@/components/billing/PricingSection';
import {
  useSubscription,
  useCreditBalance,
  useSubscriptionCommitment,
  useScheduledChanges,
} from '@/lib/billing';
import { useAuthContext } from '@/contexts';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';

interface BillingPageProps {
  visible: boolean;
  onClose: () => void;
}

export function BillingPage({ visible, onClose }: BillingPageProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const isAuthenticated = !!user;

  // Use React Query hooks for subscription data - only when visible and authenticated
  const {
    data: subscriptionData,
    isLoading: isLoadingSubscription,
    error: subscriptionError,
    refetch: refetchSubscription
  } = useSubscription({
    enabled: visible && isAuthenticated,
  });

  const {
    refetch: refetchCommitment
  } = useSubscriptionCommitment(subscriptionData?.subscription?.id, {
    enabled: visible && !!subscriptionData?.subscription?.id
  });

  const {
    refetch: refetchBalance
  } = useCreditBalance({
    enabled: visible && isAuthenticated
  });

  const {
    refetch: refetchScheduledChanges
  } = useScheduledChanges({
    enabled: visible && isAuthenticated
  });

  const handleClose = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const isLoading = isLoadingSubscription;
  const error = subscriptionError ? (subscriptionError instanceof Error ? subscriptionError.message : 'Failed to load subscription data') : null;

  if (!visible) return null;

  if (isLoading) {
    return (
      <View className="absolute inset-0 z-50 bg-background">
        <SettingsHeader title={t('billing.title')} onClose={handleClose} />
        <View className="p-6">
          <Text className="text-muted-foreground">{t('billing.loading')}</Text>
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View className="absolute inset-0 z-50 bg-background">
        <SettingsHeader title={t('billing.title')} onClose={handleClose} />
        <View className="p-6">
          <View className="bg-destructive/10 border border-destructive/20 rounded-[18px] p-4">
            <View className="flex-row items-start gap-2">
              <Icon as={AlertTriangle} size={16} className="text-destructive" strokeWidth={2} />
              <Text className="text-sm font-roobert-medium text-destructive flex-1">
                {error}
              </Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  const subscription = subscriptionData?.subscription;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <SettingsHeader
          title={t('billing.title')}
          onClose={handleClose}
        />

        <PricingSection
          showTitleAndTabs={true}
          hideFree={false}
          insideDialog={false}
          noPadding={false}
          onSubscriptionUpdate={() => {
            refetchSubscription();
            refetchBalance();
            refetchCommitment();
            refetchScheduledChanges();
          }}
        />
      </View>
    </View>
  );
}
