/**
 * Billing Page Component
 * 
 * Matches frontend's billing tab design exactly
 * Uses hooks directly like frontend (no context)
 */

import React, { useState, useRef, useEffect } from 'react';
import { View, Pressable, Linking, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  CreditCard, 
  Clock, 
  Infinity,
  ShoppingCart,
  Lightbulb,
  Shield,
  AlertTriangle,
  RotateCcw
} from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { PlanSelectionModal } from '@/components/billing/PlanSelectionModal';
import { CreditsPurchasePage } from './CreditsPurchasePage';
import { 
  useSubscription, 
  useCreditBalance, 
  useSubscriptionCommitment,
  useScheduledChanges,
  useCreatePortalSession,
  useCancelSubscription,
  useReactivateSubscription,
  billingKeys
} from '@/lib/billing';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from '@/contexts';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';
import { formatCredits, dollarsToCredits } from '@/lib/utils/credit-formatter';
import { TierBadge } from '@/components/menu/TierBadge';
import type { TierType } from '@/components/menu/types';

// Format date
function formatDate(dateString: string | number): string {
  const date = typeof dateString === 'number' 
    ? new Date(dateString * 1000)
    : new Date(dateString);
  
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatDateFlexible(dateValue: string | number): string {
  if (typeof dateValue === 'number') {
    return formatDate(dateValue);
  }
  return formatDate(dateValue);
}

function formatEndDate(dateString: string): string {
  try {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  } catch {
    return dateString;
  }
}

// Get plan name helper (matching frontend)
function getPlanName(subscriptionData: any): string {
  if (!subscriptionData) {
    return 'Basic';
  }

  if (subscriptionData?.tier?.name === 'free' || subscriptionData?.tier_key === 'free') {
    return 'Basic';
  }

  const tierKey = subscriptionData?.tier_key || subscriptionData?.tier?.name || subscriptionData?.plan_name;
  
  // Map tier keys to plan names
  const tierMap: Record<string, string> = {
    'tier_2_20': 'Plus',
    'tier_6_50': 'Pro',
    'tier_12_100': 'Business',
    'tier_25_200': 'Ultra',
  };

  return tierMap[tierKey] || subscriptionData?.display_plan_name || subscriptionData?.tier?.display_name || 'Basic';
}

interface BillingPageProps {
  visible: boolean;
  onClose: () => void;
  onOpenCredits: () => void;
}

export function BillingPage({ visible, onClose, onOpenCredits }: BillingPageProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const queryClient = useQueryClient();
  const isAuthenticated = !!user;
  
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  // Use React Query hooks for subscription data (matching frontend exactly)
  const {
    data: subscriptionData,
    isLoading: isLoadingSubscription,
    error: subscriptionError,
    refetch: refetchSubscription
  } = useSubscription({
    enabled: isAuthenticated,
  });

  const {
    data: commitmentInfo,
    isLoading: commitmentLoading,
    error: commitmentError,
    refetch: refetchCommitment
  } = useSubscriptionCommitment(subscriptionData?.subscription?.id, {
    enabled: !!subscriptionData?.subscription?.id
  });

  const {
    data: creditBalance,
    isLoading: isLoadingBalance,
    refetch: refetchBalance
  } = useCreditBalance({
    enabled: isAuthenticated
  });

  const {
    data: scheduledChangesData,
    refetch: refetchScheduledChanges
  } = useScheduledChanges({
    enabled: isAuthenticated
  });

  const createPortalSessionMutation = useCreatePortalSession();
  const cancelSubscriptionMutation = useCancelSubscription();
  const reactivateSubscriptionMutation = useReactivateSubscription();

  const planName = getPlanName(subscriptionData);
  
  // Get TierType for TierBadge component
  const getTierType = (): TierType => {
    const name = planName.toLowerCase();
    if (name === 'plus') return 'Plus';
    if (name === 'pro' || name === 'business') return 'Pro';
    if (name === 'ultra') return 'Ultra';
    return 'Basic'; // Default to Basic
  };
  
  const tierType = getTierType();

  // Calculate days until refresh
  const getDaysUntilRefresh = () => {
    if (!creditBalance?.next_credit_grant) return null;
    const nextGrant = new Date(creditBalance.next_credit_grant);
    const now = new Date();
    const diffTime = nextGrant.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? diffDays : null;
  };

  const daysUntilRefresh = getDaysUntilRefresh();
  // Convert dollar amounts to credits (balance comes in dollars, need to convert to credits)
  const expiringCredits = dollarsToCredits(creditBalance?.expiring_credits || 0);
  const nonExpiringCredits = dollarsToCredits(creditBalance?.non_expiring_credits || 0);
  const totalCredits = dollarsToCredits(creditBalance?.balance || 0);

  // Refetch billing info when page becomes visible
  const prevVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !prevVisibleRef.current && isAuthenticated) {
      console.log('🔄 Billing page activated, refetching billing info...');
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
    }
    prevVisibleRef.current = visible;
  }, [visible, isAuthenticated, queryClient]);

  const getEffectiveCancellationDate = () => {
    if (subscriptionData?.subscription?.cancel_at) {
      const cancelAt = subscriptionData.subscription.cancel_at;
      if (typeof cancelAt === 'number') {
        return formatDate(cancelAt);
      }
      return formatDate(cancelAt);
    }
    if (subscriptionData?.subscription?.current_period_end) {
      return formatDateFlexible(subscriptionData.subscription.current_period_end);
    }
    return 'N/A';
  };

  const handleClose = () => {
    console.log('🎯 Billing page closed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  const handleManageSubscription = async () => {
    const returnUrl = 'https://kortix.com/subscription';
    createPortalSessionMutation.mutate(
      { return_url: returnUrl },
      {
        onSuccess: (data) => {
          if (data?.portal_url) {
            Linking.openURL(data.portal_url);
          }
        },
      }
    );
  };

  const handleChangePlan = () => {
    console.log('🎯 Change Plan pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowPlanModal(true);
  };

  const handlePurchaseCredits = () => {
    console.log('🎯 Purchase Credits pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowCreditsModal(true);
  };

  const handleCancel = () => {
    setShowCancelDialog(false);
    cancelSubscriptionMutation.mutate(undefined);
  };

  const handleReactivate = () => {
    reactivateSubscriptionMutation.mutate();
  };

  const isLoading = isLoadingSubscription || isLoadingBalance;
  const error = subscriptionError ? (subscriptionError instanceof Error ? subscriptionError.message : 'Failed to load subscription data') : null;

  if (!visible) return null;

  if (isLoading) {
    return (
      <View className="absolute inset-0 z-50 bg-background">
        <SettingsHeader title={t('billing.title')} onClose={handleClose} />
        <View className="p-6">
          <Text className="text-muted-foreground">Loading...</Text>
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

  const isSubscribed = subscriptionData?.subscription?.status === 'active' || subscriptionData?.subscription?.status === 'trialing';
  const isFreeTier = subscriptionData?.tier?.name === 'free';
  const subscription = subscriptionData?.subscription;
  const isCancelled = subscription?.cancel_at_period_end || subscription?.cancel_at || subscription?.canceled_at;
  const canPurchaseCredits = subscriptionData?.credits?.can_purchase_credits || false;

  return (
    <View className="absolute inset-0 z-50">
      {/* Backdrop */}
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      {/* Page */}
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView 
          className="flex-1" 
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={false}
        >
          {/* Header */}
          <SettingsHeader
            title={t('billing.title')}
            onClose={handleClose}
          />

          <View className="px-6 pb-8">
            {/* Header with Plan Badge on Right */}
            <View className="mb-8 flex-row items-start justify-between gap-4">
              <View className="flex-1">
                <Text className="text-2xl font-roobert-semibold text-foreground">
                  Billing Status
                </Text>
                <Text className="text-sm font-roobert text-muted-foreground mt-1">
                  Manage your credits and subscription
                </Text>
              </View>

              {/* Plan Badge with Renewal Info - Right aligned */}
              {!isFreeTier && planName && subscription?.current_period_end && (
                <View className="items-end">
                  <View className="mb-1">
                    <TierBadge tier={tierType} size="small" />
                  </View>
                  <Text className="text-xs font-roobert text-muted-foreground mt-0.5">
                    Renews {formatDateFlexible(subscription.current_period_end)}
                  </Text>
                </View>
              )}
            </View>

            {/* Credit Breakdown - 3 Cards Stack */}
            <View className="mb-8 gap-4">
              {/* Total Available Credits */}
              <View className="bg-card border border-border rounded-[18px] p-6">
                <View className="mb-4 flex-row items-center gap-2">
                  <Icon as={CreditCard} size={16} className="text-muted-foreground" strokeWidth={2} />
                  <Text className="text-sm font-roobert-medium text-muted-foreground">
                    Total Available Credits
                  </Text>
                </View>
                <View>
                  <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
                    {formatCredits(totalCredits)}
                  </Text>
                  <Text className="text-xs font-roobert text-muted-foreground">
                    All credits
                  </Text>
                </View>
              </View>

              {/* Monthly Credits */}
              <View className="bg-card border border-orange-500/20 rounded-[18px] p-6">
                <View className="mb-4 flex-row items-center gap-2">
                  <Icon as={Clock} size={16} className="text-orange-500" strokeWidth={2} />
                  <Text className="text-sm font-roobert-medium text-muted-foreground">
                    Monthly Credits
                  </Text>
                </View>
                <View>
                  <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
                    {formatCredits(expiringCredits)}
                  </Text>
                  <Text className="text-xs font-roobert text-muted-foreground">
                    {daysUntilRefresh !== null 
                      ? `Renewal in ${daysUntilRefresh} ${daysUntilRefresh === 1 ? 'day' : 'days'}`
                      : 'No renewal scheduled'
                    }
                  </Text>
                </View>
              </View>

              {/* Extra Credits */}
              <View className="bg-card border border-border rounded-[18px] p-6">
                <View className="mb-4 flex-row items-center gap-2">
                  <Icon as={Infinity} size={16} className="text-muted-foreground" strokeWidth={2} />
                  <Text className="text-sm font-roobert-medium text-muted-foreground">
                    Extra Credits
                  </Text>
                </View>
                <View>
                  <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
                    {formatCredits(nonExpiringCredits)}
                  </Text>
                  <Text className="text-xs font-roobert text-muted-foreground">
                    Non-expiring
                  </Text>
                </View>
              </View>
            </View>

            {/* Action Buttons */}
            <View className="mb-8 gap-3">
              <Pressable
                onPress={handleManageSubscription}
                disabled={createPortalSessionMutation.isPending}
                className="h-10 bg-primary rounded-xl items-center justify-center"
              >
                <Text className="text-sm font-roobert-medium text-primary-foreground">
                  {createPortalSessionMutation.isPending ? 'Loading...' : 'Manage Subscription'}
                </Text>
              </Pressable>

              {canPurchaseCredits && (
                <Pressable
                  onPress={handlePurchaseCredits}
                  className="h-10 border border-border rounded-xl items-center justify-center flex-row gap-2"
                >
                  <Icon as={ShoppingCart} size={16} className="text-foreground" strokeWidth={2} />
                  <Text className="text-sm font-roobert-medium text-foreground">
                    Get Additional Credits
                  </Text>
                </Pressable>
              )}

              {!isFreeTier && planName && (
                <Pressable
                  onPress={handleChangePlan}
                  className="h-10 border border-border rounded-xl items-center justify-center"
                >
                  <Text className="text-sm font-roobert-medium text-foreground">
                    Change Plan
                  </Text>
                </Pressable>
              )}
            </View>

            {/* Commitment Alert */}
            {commitmentInfo?.has_commitment && (
              <View className="mb-8 bg-blue-500/5 border border-blue-500/20 rounded-[18px] p-4">
                <View className="flex-row items-start gap-3">
                  <Icon as={Shield} size={16} className="text-blue-500 mt-0.5" strokeWidth={2} />
                  <View className="flex-1">
                    <Text className="mb-1 text-sm font-roobert-medium text-foreground">
                      Annual Commitment
                    </Text>
                    <Text className="text-sm font-roobert text-muted-foreground">
                      Active until {formatEndDate(commitmentInfo.commitment_end_date || '')}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Scheduled Changes */}
            {scheduledChangesData?.has_scheduled_change && scheduledChangesData.scheduled_change && (
              <View className="mb-8">
                <ScheduledDowngradeCard
                  scheduledChange={scheduledChangesData.scheduled_change}
                  onCancel={() => {
                    refetchSubscription();
                    refetchScheduledChanges();
                  }}
                />
              </View>
            )}

            {/* Cancellation Alert */}
            {isCancelled && (
              <View className="mb-8 bg-destructive/10 border border-destructive/20 rounded-[18px] p-4">
                <View className="flex-row items-start gap-3">
                  <Icon as={AlertTriangle} size={16} className="text-destructive mt-0.5" strokeWidth={2} />
                  <View className="flex-1">
                    <Text className="mb-1 text-sm font-roobert-medium text-destructive">
                      Subscription Cancelled
                    </Text>
                    <Text className="mb-3 text-sm font-roobert text-muted-foreground">
                      Your subscription will be cancelled on {getEffectiveCancellationDate()}
                    </Text>
                    <Pressable
                      onPress={handleReactivate}
                      disabled={reactivateSubscriptionMutation.isPending}
                    >
                      <Text className="text-sm font-roobert-medium text-primary">
                        {reactivateSubscriptionMutation.isPending ? 'Reactivating...' : 'Reactivate'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            )}

            {/* Reactivate Button (if cancelled) */}
            {isCancelled && (
              <View className="mb-8 items-center">
                <Pressable
                  onPress={handleReactivate}
                  disabled={reactivateSubscriptionMutation.isPending}
                  className="h-10 border border-border rounded-xl items-center justify-center flex-row gap-2 px-4"
                >
                  <Icon as={RotateCcw} size={14} className="text-foreground" strokeWidth={2} />
                  <Text className="text-sm font-roobert-medium text-foreground">
                    {reactivateSubscriptionMutation.isPending ? 'Reactivating...' : 'Reactivate Subscription'}
                  </Text>
                </Pressable>
              </View>
            )}

            {/* Help Link */}
            <View className="mb-6 items-center border-t border-border/50 pt-6">
              <Pressable
                onPress={() => {
                  const url = 'https://kortix.com/credits-explained';
                  Linking.openURL(url);
                }}
                className="flex-row items-center gap-2"
              >
                <Icon as={Lightbulb} size={14} className="text-muted-foreground" strokeWidth={2} />
                <Text className="text-sm font-roobert text-muted-foreground">
                  Credits explained
                </Text>
              </Pressable>
            </View>

            {/* Cancel Plan Button - Subtle Placement */}
            {!isFreeTier && !isCancelled && (
              <View className="mb-8 items-center">
                <Pressable
                  onPress={() => setShowCancelDialog(true)}
                  className="py-2"
                >
                  <Text className="text-xs font-roobert text-muted-foreground">
                    Cancel Plan
                  </Text>
                </Pressable>
              </View>
            )}

            {/* Bottom spacing for safe scrolling */}
            <View className="h-6" />
          </View>
        </ScrollView>
      </View>

      {/* Plan Selection Modal */}
      <PlanSelectionModal
        open={showPlanModal}
        onOpenChange={setShowPlanModal}
      />

      {/* Credits Purchase Modal */}
      <CreditsPurchasePage
        visible={showCreditsModal}
        onClose={() => setShowCreditsModal(false)}
      />
    </View>
  );
}
