/**
 * Billing Page Component
 * 
 * Matches frontend's billing tab design exactly
 * Uses hooks directly like frontend (no context)
 */

import React, { useState, useRef, useEffect } from 'react';
import { View, Pressable, Linking, ScrollView, ActivityIndicator, useColorScheme } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  CreditCard,
  Clock,
  Infinity,
  ShoppingCart,
  Shield,
  AlertTriangle,
  RotateCcw,
  ArrowUpDown,
  Wallet,
  HelpCircle,
  TrendingDown,
  ChevronRight
} from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
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
  useThreadUsage,
  billingKeys
} from '@/lib/billing';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from '@/contexts';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { ScheduledDowngradeCard } from '@/components/billing/ScheduledDowngradeCard';
import { formatCredits } from '@/lib/utils/credit-formatter';
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
  onOpenUsage: () => void;
  alertTitle?: string;
}

export function BillingPage({ visible, onClose, onOpenCredits, onOpenUsage, alertTitle }: BillingPageProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const queryClient = useQueryClient();
  const isAuthenticated = !!user;

  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

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
    data: commitmentInfo,
    isLoading: commitmentLoading,
    error: commitmentError,
    refetch: refetchCommitment
  } = useSubscriptionCommitment(subscriptionData?.subscription?.id, {
    enabled: visible && !!subscriptionData?.subscription?.id
  });

  const {
    data: creditBalance,
    isLoading: isLoadingBalance,
    refetch: refetchBalance
  } = useCreditBalance({
    enabled: visible && isAuthenticated
  });

  const {
    data: scheduledChangesData,
    refetch: refetchScheduledChanges
  } = useScheduledChanges({
    enabled: visible && isAuthenticated
  });

  const createPortalSessionMutation = useCreatePortalSession();
  const cancelSubscriptionMutation = useCancelSubscription();
  const reactivateSubscriptionMutation = useReactivateSubscription();

  // Memoize expensive calculations - only recalculate when data changes
  const planName = React.useMemo(() => getPlanName(subscriptionData), [subscriptionData]);

  const tierType = React.useMemo((): TierType => {
    const name = planName.toLowerCase();
    if (name === 'plus') return 'Plus';
    if (name === 'pro' || name === 'business') return 'Pro';
    if (name === 'ultra') return 'Ultra';
    return 'Basic';
  }, [planName]);

  const daysUntilRefresh = React.useMemo(() => {
    if (!creditBalance?.next_credit_grant) return null;
    const nextGrant = new Date(creditBalance.next_credit_grant);
    const now = new Date();
    const diffTime = nextGrant.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? diffDays : null;
  }, [creditBalance?.next_credit_grant]);

  const expiringCredits = React.useMemo(() =>
    creditBalance?.expiring_credits || 0,
    [creditBalance?.expiring_credits]
  );

  const nonExpiringCredits = React.useMemo(() =>
    creditBalance?.non_expiring_credits || 0,
    [creditBalance?.non_expiring_credits]
  );

  const totalCredits = React.useMemo(() =>
    creditBalance?.balance || 0,
    [creditBalance?.balance]
  );

  // Memoize derived state
  const cancellationDate = React.useMemo(() => {
    if (subscriptionData?.subscription?.cancel_at) {
      const cancelAt = subscriptionData.subscription.cancel_at;
      return typeof cancelAt === 'number' ? formatDate(cancelAt) : formatDate(cancelAt);
    }
    if (subscriptionData?.subscription?.current_period_end) {
      return formatDateFlexible(subscriptionData.subscription.current_period_end);
    }
    return 'N/A';
  }, [subscriptionData?.subscription]);

  const isSubscribed = React.useMemo(() =>
    subscriptionData?.subscription?.status === 'active' || subscriptionData?.subscription?.status === 'trialing',
    [subscriptionData?.subscription?.status]
  );

  const isFreeTier = React.useMemo(() =>
    subscriptionData?.tier?.name === 'free',
    [subscriptionData?.tier?.name]
  );

  const isCancelled = React.useMemo(() => {
    const sub = subscriptionData?.subscription;
    return !!(sub?.cancel_at_period_end || sub?.cancel_at || sub?.canceled_at);
  }, [subscriptionData?.subscription]);

  const canPurchaseCredits = React.useMemo(() =>
    subscriptionData?.credits?.can_purchase_credits || false,
    [subscriptionData?.credits?.can_purchase_credits]
  );

  // Memoize handlers to prevent unnecessary re-renders
  const handleClose = React.useCallback(() => {
    console.log('🎯 Billing page closed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleManageSubscription = React.useCallback(async () => {
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
  }, [createPortalSessionMutation]);

  const handleChangePlan = React.useCallback(() => {
    console.log('🎯 Change Plan pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowPlanModal(true);
  }, []);

  const handlePurchaseCredits = React.useCallback(() => {
    console.log('🎯 Purchase Credits pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setShowCreditsModal(true);
  }, []);

  const handleCancel = React.useCallback(() => {
    setShowCancelDialog(false);

    // Check if user is on RevenueCat
    const provider = subscriptionData?.provider || 'stripe';

    if (provider === 'revenuecat') {
      // RevenueCat users must cancel in-app
      const isIOS = require('react-native').Platform.OS === 'ios';
      const message = isIOS
        ? 'To cancel your subscription, please go to:\n\nSettings → [Your Name] → Subscriptions → Kortix'
        : 'To cancel your subscription, please go to:\n\nPlay Store → Subscriptions → Kortix';

      require('react-native').Alert.alert(
        'Manage Subscription',
        message,
        [
          { text: 'OK', style: 'default' }
        ]
      );
      return;
    }

    // Stripe cancellation
    cancelSubscriptionMutation.mutate(undefined);
  }, [cancelSubscriptionMutation, subscriptionData]);

  const handleReactivate = React.useCallback(() => {
    reactivateSubscriptionMutation.mutate();
  }, [reactivateSubscriptionMutation]);

  const isLoading = isLoadingSubscription || isLoadingBalance;
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
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <SettingsHeader
            title={t('billing.title')}
            onClose={handleClose}
          />

          <View className="px-6 pb-8">
            {alertTitle && (
              <View className="mb-6 bg-primary/10 border border-primary/20 rounded-2xl p-4">
                <View className="flex-row items-start gap-3">
                  <Icon as={AlertTriangle} size={20} className="text-primary mt-0.5" strokeWidth={2} />
                  <Text className="flex-1 text-sm font-roobert text-foreground">
                    {alertTitle}
                  </Text>
                </View>
              </View>
            )}
            <View className="mb-4 items-center pt-4">
              <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Icon as={CreditCard} size={28} className="text-primary" strokeWidth={2} />
              </View>
              <Text className="mb-1 text-5xl font-roobert-semibold text-foreground tracking-tight">
                {formatCredits(totalCredits)}
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground">
                {t('billing.totalAvailableCredits')}
              </Text>
            </View>
            {tierType !== 'Ultra' ? (
              <View className="mb-4 items-center">
                <Pressable
                  onPress={handleChangePlan}
                  className="w-36 rounded-full bg-primary border border-border/40 rounded-2xl px-4 py-3 flex-row items-center justify-center gap-2 active:opacity-80"
                >
                  <Icon as={CreditCard} size={16} className="text-primary-foreground" strokeWidth={2.5} />
                  <Text className="text-sm font-roobert-medium text-primary-foreground">
                    {t('billing.upgrade')}
                  </Text>
                </Pressable>
              </View>
            ) : canPurchaseCredits && (
              <View className="mb-4 items-center">
                <Pressable
                  onPress={handlePurchaseCredits}
                  className="w-36 rounded-full bg-primary border border-border/40 rounded-2xl px-4 py-3 flex-row items-center justify-center gap-2 active:opacity-80"
                >
                  <Icon as={CreditCard} size={16} className="text-primary-foreground" strokeWidth={2.5} />
                  <Text className="text-sm font-roobert-medium text-primary-foreground">
                    {t('billing.topUp')}
                  </Text>
                </Pressable>
              </View>
            )}

            <UsageSection visible={visible} onOpenFullUsage={onOpenUsage} />

            <View className="mb-6">
              <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                {t('billing.creditBreakdown')}
              </Text>
              <View className="flex-row gap-3">
                <View className="flex-1 bg-primary/5 rounded-3xl p-5">
                  <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-primary">
                    <Icon as={Clock} size={18} className="text-primary-foreground" strokeWidth={2.5} />
                  </View>
                  <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
                    {formatCredits(expiringCredits)}
                  </Text>
                  <Text className="mb-1 text-xs font-roobert-medium text-muted-foreground">
                    {t('billing.monthly')}
                  </Text>
                  <Text className="text-[10px] font-roobert text-primary">
                    {daysUntilRefresh !== null
                      ? t('billing.renewsInDays', { days: daysUntilRefresh })
                      : t('billing.noRenewal')
                    }
                  </Text>
                </View>
                <View className="flex-1 bg-primary/5 rounded-3xl p-5">
                  <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-primary">
                    <Icon as={Infinity} size={18} className="text-primary-foreground" strokeWidth={2.5} />
                  </View>
                  <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
                    {formatCredits(nonExpiringCredits)}
                  </Text>
                  <Text className="mb-1 text-xs font-roobert-medium text-muted-foreground">
                    {t('billing.extra')}
                  </Text>
                  <Text className="text-[10px] font-roobert text-primary">
                    {t('billing.neverExpires')}
                  </Text>
                </View>
              </View>
            </View>

            {!isFreeTier && subscription?.current_period_end && (
              <View className="mb-6 bg-primary/5 rounded-3xl p-4">
                <View className="flex-row items-center justify-between">
                  <View>
                    <Text className="mb-0.5 text-xs font-roobert-medium text-muted-foreground">
                      {t('billing.currentPlan')}
                    </Text>
                    <View className="mt-1">
                      <TierBadge tier={tierType} size="small" />
                    </View>
                  </View>
                  <View className="items-end">
                    <Text className="mb-0.5 text-xs font-roobert-medium text-muted-foreground">
                      {t('billing.nextBilling')}
                    </Text>
                    <Text className="text-sm font-roobert-medium text-foreground">
                      {formatDateFlexible(subscription.current_period_end)}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Secondary Actions Grid */}
            <View className="mb-6">
              {!isFreeTier && planName ? (
                <View className="flex-row gap-3">
                  <Pressable
                    onPress={handleChangePlan}
                    className="flex-1 bg-primary/5 rounded-3xl p-4 active:opacity-80"
                  >
                    <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-amber-500">
                      <Icon as={ArrowUpDown} size={20} className="text-white" strokeWidth={2.5} />
                    </View>
                    <Text className="text-sm font-roobert-semibold text-foreground mb-1">
                      {t('billing.changePlan')}
                    </Text>
                    <Text className="text-xs font-roobert text-muted-foreground">
                      {t('billing.upgradeOrDowngrade')}
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={handleManageSubscription}
                    disabled={createPortalSessionMutation.isPending}
                    className="flex-1 bg-primary/5 rounded-3xl p-4 active:opacity-80"
                  >
                    <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-indigo-500">
                      <Icon as={Wallet} size={20} className="text-white" strokeWidth={2.5} />
                    </View>
                    <Text className="text-sm font-roobert-semibold text-foreground mb-1">
                      {createPortalSessionMutation.isPending ? t('billing.loading') : t('billing.billingPortal')}
                    </Text>
                    <Text className="text-xs font-roobert text-muted-foreground">
                      {t('billing.paymentMethods')}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={handleManageSubscription}
                  disabled={createPortalSessionMutation.isPending}
                  className="bg-card border border-border/40 rounded-2xl p-4 active:opacity-80"
                >
                  <View className="flex-row items-center gap-3">
                    <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                      <Icon as={Wallet} size={20} className="text-muted-foreground" strokeWidth={2.5} />
                    </View>
                    <View className="flex-1">
                      <Text className="text-sm font-roobert-semibold text-foreground mb-0.5">
                        {createPortalSessionMutation.isPending ? t('billing.loading') : t('billing.billingPortal')}
                      </Text>
                      <Text className="text-xs font-roobert text-muted-foreground">
                        {t('billing.paymentMethods')}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              )}
            </View>

            {/* Commitment Alert */}
            {commitmentInfo?.has_commitment && (
              <View className="mb-6 bg-blue-500/5 border border-blue-500/20 rounded-2xl p-5">
                <View className="flex-row items-start gap-4">
                  <View className="h-10 w-10 items-center justify-center rounded-full bg-blue-500/10">
                    <Icon as={Shield} size={18} className="text-blue-500" strokeWidth={2.5} />
                  </View>
                  <View className="flex-1">
                    <Text className="mb-1 text-sm font-roobert-semibold text-foreground">
                      {t('billing.annualCommitment')}
                    </Text>
                    <Text className="text-xs font-roobert text-muted-foreground">
                      {t('billing.activeUntil', { date: formatEndDate(commitmentInfo.commitment_end_date || '') })}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Scheduled Changes */}
            {scheduledChangesData?.has_scheduled_change && scheduledChangesData.scheduled_change && (
              <View className="mb-6">
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
              <View className="mb-6 bg-destructive/5 border border-destructive/20 rounded-2xl p-5">
                <View className="flex-row items-start gap-4">
                  <View className="h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
                    <Icon as={AlertTriangle} size={18} className="text-destructive" strokeWidth={2.5} />
                  </View>
                  <View className="flex-1">
                    <Text className="mb-1 text-sm font-roobert-semibold text-destructive">
                      {t('billing.subscriptionCancelled')}
                    </Text>
                    <Text className="mb-4 text-xs font-roobert text-muted-foreground">
                      {t('billing.subscriptionCancelledOn', { date: cancellationDate })}
                    </Text>
                    <Pressable
                      onPress={handleReactivate}
                      disabled={reactivateSubscriptionMutation.isPending}
                      className="flex-row items-center gap-2 bg-primary rounded-xl px-4 py-2.5 self-start active:opacity-80"
                    >
                      <Icon as={RotateCcw} size={14} className="text-primary-foreground" strokeWidth={2.5} />
                      <Text className="text-sm font-roobert-medium text-primary-foreground">
                        {reactivateSubscriptionMutation.isPending ? t('billing.reactivating') : t('billing.reactivate')}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            )}

            {/* Help & Support */}
            <View className="mb-6 bg-muted/30 rounded-2xl p-5">
              <Pressable
                onPress={() => {
                  const url = 'https://kortix.com/credits-explained';
                  Linking.openURL(url);
                }}
                className="flex-row items-center gap-3 active:opacity-70"
              >
                <View className="h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <Icon as={HelpCircle} size={18} className="text-muted-foreground" strokeWidth={2.5} />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-roobert-semibold text-foreground">
                    {t('billing.howCreditsWork')}
                  </Text>
                  <Text className="text-xs font-roobert text-muted-foreground">
                    {t('billing.learnAboutCredits')}
                  </Text>
                </View>
              </Pressable>
            </View>

            {/* Cancel Plan Button - Subtle Placement */}
            {!isFreeTier && !isCancelled && (
              <View className="mb-8 items-center">
                <Pressable
                  onPress={() => setShowCancelDialog(true)}
                  className="py-3 px-4 active:opacity-60"
                >
                  <Text className="text-xs font-roobert-medium text-muted-foreground">
                    {t('billing.cancelPlan')}
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
      <AnimatedPageWrapper visible={showCreditsModal} onClose={() => setShowCreditsModal(false)}>
        <CreditsPurchasePage
          visible={showCreditsModal}
          onClose={() => setShowCreditsModal(false)}
        />
      </AnimatedPageWrapper>
    </View>
  );
}

interface UsageSectionProps {
  visible: boolean;
  onOpenFullUsage: () => void;
}

function UsageSection({ visible, onOpenFullUsage }: UsageSectionProps) {
  const { t } = useLanguage();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [dateRange] = React.useState({
    from: new Date(new Date().setDate(new Date().getDate() - 29)),
    to: new Date(),
  });

  const { data: usageData, isLoading } = useThreadUsage({
    limit: 3,
    offset: 0,
    startDate: dateRange.from,
    endDate: dateRange.to,
    enabled: visible,
  });

  if (isLoading) {
    return (
      <View className="mb-6 bg-muted/5 border border-border/50 rounded-2xl p-5">
        <View className="flex-row items-center justify-center py-8">
          <ActivityIndicator size="small" />
        </View>
      </View>
    );
  }

  if (!usageData || !usageData.summary) {
    return null;
  }

  const summary = usageData.summary;

  const graphData = [45, 52, 48, 65, 58, 72, 68, 85, 78, 92, 88, 95, 82, 88, 75, 68, 72, 65, 80, 75];

  const width = 280;
  const height = 80;
  const points = graphData.map((value, index) => {
    // Validate and clamp values to prevent NaN
    const safeValue = typeof value === 'number' && !isNaN(value) && isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : 0;
    const safeIndex = typeof index === 'number' && !isNaN(index) ? index : 0;
    const safeLength = graphData.length > 1 ? graphData.length - 1 : 1;

    const x = (safeIndex / safeLength) * width;
    const y = height - (safeValue / 100) * height;

    // Ensure x and y are valid numbers
    return {
      x: isFinite(x) ? x : 0,
      y: isFinite(y) ? y : height
    };
  });

  const pathData = points.map((point, index) => {
    if (index === 0) {
      return `M ${point.x} ${point.y}`;
    }
    const prevPoint = points[index - 1];
    const controlX = (prevPoint.x + point.x) / 2;
    // Validate all values before using in path
    const safeControlX = isFinite(controlX) ? controlX : point.x;
    const safePrevY = isFinite(prevPoint.y) ? prevPoint.y : point.y;
    return `Q ${safeControlX} ${safePrevY}, ${point.x} ${point.y}`;
  }).join(' ');

  const strokeColor = isDark ? '#ffffff' : '#000000';

  return (
    <View className="mb-6">
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onOpenFullUsage();
        }}
        className="active:opacity-90 bg-transparent"
      >
        <View className="rounded-3xl p-5 overflow-hidden">
          <View className="absolute inset-0 bg-primary/5 rounded-3xl" />
          <View className="absolute top-1/3 left-1/2 -translate-x-1/2 w-3/4 h-1/3 bg-primary/10 rounded-full" style={{ filter: 'blur(40px)' }} />
          <View className="relative">
            <View className="flex-row items-start justify-between">
              <View className="h-8 w-8 items-center justify-center rounded-full bg-green-500">
                <Icon as={TrendingDown} size={20} className="text-white" strokeWidth={2.5} />
              </View>
              <View className="absolute right-0 top-0">
                <Svg width={180} height={60} viewBox={`0 0 ${width} ${height}`}>
                  <Path
                    d={pathData}
                    stroke={strokeColor}
                    strokeWidth="2.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Svg>
              </View>
            </View>

            <View className="flex-row items-end justify-between mt-4">
              <View>
                <Text className="text-sm font-roobert text-muted-foreground">
                  {t('billing.usage')}
                </Text>
                <Text className="text-lg font-roobert-medium text-muted-foreground">
                  {t('billing.last30Days')}
                </Text>
              </View>
              <View className="items-end">
                <Text className="text-4xl font-roobert-semibold text-foreground">
                  {formatCredits(summary.total_credits_used)}
                </Text>
              </View>
            </View>
          </View>
        </View>
      </Pressable>
    </View>
  );
}
