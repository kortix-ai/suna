'use client';

import type { PricingTier } from '@/lib/pricing-config';
import { siteConfig } from '@/lib/site-config';
import { storeCheckoutData, trackSelectItem, trackViewItem, trackAddToCart, PlanItemData } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import React, { useState, useEffect, useCallback } from 'react';
import {
  CheckIcon,
  ShoppingCart,
  Lightbulb,
  X,
  Copy,
  Gift,
  Timer,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AccountState } from '@/lib/api/billing';
import { createCheckoutSession, CreateCheckoutSessionRequest, CreateCheckoutSessionResponse } from '@/lib/api/billing';
import { toast } from '@/lib/toast';
import { isLocalMode } from '@/lib/config';
import { useAccountState, useScheduleDowngrade } from '@/hooks/billing';
import { useAuth } from '@/components/AuthProvider';
import { useQueryClient } from '@tanstack/react-query';
import { ScheduledDowngradeCard } from '@/components/billing/scheduled-downgrade-card';
import posthog from 'posthog-js';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { TierBadge } from '@/components/billing/tier-badge';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { CreditPurchaseModal } from '@/components/billing/credit-purchase';
import { BorderBeam } from '@/components/ui/border-beam';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { DowngradeConfirmationDialog } from '@/components/billing/downgrade-confirmation-dialog';
import { useUserCurrency } from '@/hooks/use-user-currency';
import { useLanguage } from '@/hooks/use-language';
import { convertPriceString, parsePriceAmount, formatPrice } from '@/lib/utils/currency';
import { usePromo } from '@/hooks/utils/use-promo';
import { backendApi } from '@/lib/api-client';

// Constants
export const SUBSCRIPTION_PLANS = {
  FREE: 'free',
  PRO: 'base',
  ENTERPRISE: 'extra',
};

// Types
type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'ghost'
  | 'outline'
  | 'link'
  | null;

interface PriceDisplayProps {
  price: string;
  isCompact?: boolean;
}

// All enabled features use CheckIcon for consistency
const FeatureCheckIcon = () => <CheckIcon className="size-3.5 sm:size-4 text-primary" />;

// Components
function PriceDisplay({ price, isCompact }: PriceDisplayProps) {
  return (
    <motion.span
      key={price}
      className={isCompact ? 'text-xl font-medium' : 'text-[40px] sm:text-[48px] font-medium leading-none'}
      initial={{
        opacity: 0,
        x: 10,
        filter: 'blur(5px)',
      }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
    >
      {price}
    </motion.span>
  );
}

interface PricingCardProps {
  tier: PricingTier;
  currentSubscription: AccountState | null;
  isLoading: Record<string, boolean>;
  isFetchingPlan: boolean;
  onPlanSelect?: (planId: string) => void;
  onSubscriptionUpdate?: () => void;
  isAuthenticated?: boolean;
  returnUrl: string;
  billingPeriod: 'monthly' | 'yearly' | 'yearly_commitment';
  currentBillingPeriod?: 'monthly' | 'yearly' | 'yearly_commitment' | null;
  isPopularHighlight?: boolean;
}

function PricingCard({
  tier,
  currentSubscription,
  isLoading,
  isFetchingPlan,
  onPlanSelect,
  onSubscriptionUpdate,
  isAuthenticated = false,
  returnUrl,
  billingPeriod = 'monthly',
  currentBillingPeriod = null,
  isPopularHighlight = false,
}: PricingCardProps) {
  const t = useTranslations('billing');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();

  const { currency, symbol } = useUserCurrency();
  const { locale } = useLanguage();

  const isFreeTier = tier.price === '$0' || tier.price === '€0' || tier.price === '0€';
  const effectiveBillingPeriod = isFreeTier ? 'monthly' : billingPeriod;
  const isYearly = effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment';

  const getDisplayPrice = () => {
    if (tier.price === '$0') {
      return currency === 'EUR' ? '0€' : '$0';
    }

    let basePrice = tier.price;

    if (effectiveBillingPeriod === 'yearly_commitment') {
      const regularPrice = parsePriceAmount(tier.price);
      const discountedPrice = Math.round(regularPrice * 0.85);
      basePrice = `$${discountedPrice}`;
    } else if (effectiveBillingPeriod === 'yearly' && tier.yearlyPrice) {
      const yearlyTotal = tier.yearlyPrice;
      const monthlyEquivalent = Math.round(parsePriceAmount(yearlyTotal) / 12);
      basePrice = `$${monthlyEquivalent}`;
    }

    return convertPriceString(basePrice, currency);
  };

  const displayPrice = getDisplayPrice();

  const getActualPrice = (): number => {
    const basePrice = parsePriceAmount(tier.price || '$0');
    if (effectiveBillingPeriod === 'yearly_commitment') {
      return Math.round(basePrice * 12 * 0.85);
    } else if (effectiveBillingPeriod === 'yearly' && tier.yearlyPrice) {
      return Math.round(parsePriceAmount(tier.yearlyPrice));
    }
    return basePrice;
  };

  const scheduleDowngradeMutation = useScheduleDowngrade();

  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingTierKey, setPendingTierKey] = useState<string | null>(null);

  const handleButtonClick = (tierKey: string, isDowngrade: boolean) => {
    if (isDowngrade) {
      setPendingTierKey(tierKey);
      setShowConfirmDialog(true);
    } else {
      handleSubscribe(tierKey, false);
    }
  };

  const handleConfirmedDowngrade = () => {
    if (pendingTierKey) {
      setShowConfirmDialog(false);
      handleSubscribe(pendingTierKey, true);
      setPendingTierKey(null);
    }
  };

  const handleSubscribe = async (tierKey: string, isDowngrade = false) => {
    if (!isAuthenticated) {
      window.location.href = '/auth?mode=signup';
      return;
    }

    if (isLoading[tierKey]) {
      return;
    }

    const actualPrice = getActualPrice();
    const billingLabel = effectiveBillingPeriod === 'monthly' ? 'Monthly' : 'Yearly';
    const itemData: PlanItemData = {
      item_id: `${tier.tierKey}_${effectiveBillingPeriod}`,
      item_name: `${tier.name} ${billingLabel}`,
      item_brand: 'Kortix AI',
      item_category: 'Plans',
      item_list_id: 'plans_listing',
      item_list_name: 'Plans Listing',
      price: actualPrice,
      quantity: 1,
    };
    trackAddToCart(itemData, currency, actualPrice);

    try {
      onPlanSelect?.(tierKey);
      const commitmentType = effectiveBillingPeriod === 'yearly_commitment' ? 'yearly_commitment' :
        effectiveBillingPeriod === 'yearly' ? 'yearly' : 'monthly';

      if (isDowngrade) {
        scheduleDowngradeMutation.mutate({
          target_tier_key: tierKey,
          commitment_type: commitmentType,
        }, {
          onSuccess: () => {
            posthog.capture('plan_downgrade_scheduled');
          },
          onSettled: () => {
            if (onSubscriptionUpdate) onSubscriptionUpdate();
          }
        });
        return;
      }

      const response: CreateCheckoutSessionResponse =
        await createCheckoutSession({
          tier_key: tierKey,
          success_url: `${window.location.origin}/dashboard?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: returnUrl,
          commitment_type: commitmentType,
          locale: locale,
        } as CreateCheckoutSessionRequest);

      const checkoutUrl = response.checkout_url || response.url;

      switch (response.status) {
        case 'new':
        case 'checkout_created':
        case 'commitment_created':
          if (checkoutUrl) {
            const actualPrice = getActualPrice();
            const billingLabel = effectiveBillingPeriod === 'monthly' ? 'Monthly' : 'Yearly';
            const previousTier = currentSubscription?.subscription.tier_key || currentSubscription?.tier?.name || 'none';
            storeCheckoutData({
              item_id: `${tier.tierKey}_${effectiveBillingPeriod}`,
              item_name: `${tier.name} ${billingLabel}`,
              price: actualPrice,
              value: actualPrice,
              currency: currency,
              billing_period: effectiveBillingPeriod,
              previous_tier: previousTier,
            });
            posthog.capture('plan_purchase_attempted');
            backendApi.post(`/billing/track-checkout-click?tier=${tier.tierKey}`, null, { showErrors: false });
            window.location.href = checkoutUrl;
          } else {
            toast.error(t('failedToInitiateSubscription'));
          }
          break;
        case 'upgraded':
        case 'updated':
          const upgradedActualPrice = getActualPrice();
          const upgradedBillingLabel = effectiveBillingPeriod === 'monthly' ? 'Monthly' : 'Yearly';
          const upgradedPreviousTier = currentSubscription?.subscription.tier_key || currentSubscription?.tier?.name || 'none';
          storeCheckoutData({
            item_id: `${tier.tierKey}_${effectiveBillingPeriod}`,
            item_name: `${tier.name} ${upgradedBillingLabel}`,
            price: upgradedActualPrice,
            value: upgradedActualPrice,
            currency: currency,
            billing_period: effectiveBillingPeriod,
            previous_tier: upgradedPreviousTier,
          });
          posthog.capture('plan_upgraded');
          if (onSubscriptionUpdate) onSubscriptionUpdate();
          setTimeout(() => {
            window.location.href = '/dashboard?subscription=success';
          }, 500);
          break;
        case 'commitment_blocks_downgrade':
          toast.warning(response.message || t('cannotDowngradeDuringCommitment'));
          break;
        case 'downgrade_scheduled':
        case 'scheduled':
          const dateValue = (response as any).effective_date || (response as any).scheduled_date;
          let effectiveDate = null;

          if (dateValue) {
            try {
              const parsedDate = new Date(dateValue);
              if (!isNaN(parsedDate.getTime())) {
                effectiveDate = parsedDate.toLocaleDateString();
              } else {
                effectiveDate = 'end of billing period';
              }
            } catch (e) {
              effectiveDate = 'end of billing period';
            }
          }

          const statusChangeMessage = t('subscriptionChangeScheduled');
          const planChangeDate = effectiveDate
            ? t('planWillChangeOn', { date: effectiveDate })
            : t('planWillChangeOn', { date: 'the end of your billing period' });

          toast.success(
            <div>
              <p>{statusChangeMessage}</p>
              <p className="text-sm mt-1">{planChangeDate}</p>
            </div>,
          );
          posthog.capture('plan_downgraded');
          if (onSubscriptionUpdate) onSubscriptionUpdate();
          break;
        case 'no_change':
          toast.info(response.message || t('alreadyOnThisPlan'));
          break;
        default:
          toast.error('An unexpected error occurred. Please try again.');
      }
    } catch (error: any) {
      const errorMessage =
        error?.response?.data?.detail ||
        error?.message ||
        'Failed to process subscription. Please try again.';
      toast.error(errorMessage);
    }
  };

  const currentTier = siteConfig.cloudPricingItems.find(
    (p) => p.tierKey === currentSubscription?.subscription.tier_key || p.tierKey === currentSubscription?.tier?.name,
  );

  const userPlanName = currentSubscription?.subscription.tier_display_name || 'none';

  const isSameTier =
    currentSubscription?.subscription.tier_key === tier.tierKey ||
    currentSubscription?.tier?.name === tier.tierKey ||
    currentSubscription?.subscription.tier_display_name === tier.tierKey;
  const isSameBillingPeriod = currentBillingPeriod === billingPeriod;

  const isRevenueCatSubscription = currentSubscription?.subscription.provider === 'revenuecat';

  const currentStatus = currentSubscription?.subscription.status;
  const isCurrentActivePlan = isAuthenticated && isSameTier &&
    (isSameBillingPeriod || isRevenueCatSubscription) &&
    (currentStatus === 'active' || currentStatus === 'trialing');

  const isScheduled = isAuthenticated && (currentSubscription as any)?.has_schedule;
  const isScheduledTargetPlan =
    isScheduled && (
      (currentSubscription as any)?.scheduled_tier_key === tier.tierKey ||
      (currentSubscription as any)?.scheduled_plan_name === tier.tierKey ||
      (currentSubscription as any)?.scheduled_plan_name === tier.name
    );
  const isPlanLoading = isLoading[tier.tierKey];

  let buttonText = isAuthenticated ? t('selectPlan') : tier.buttonText;
  let buttonDisabled = isPlanLoading;
  let buttonVariant: ButtonVariant = null;
  let ringClass = '';
  let statusBadge = null;
  let buttonClassName = '';
  let isDowngradeAction = false;

  const planChangeValidation = { allowed: true };

  if (isAuthenticated) {
    const isFreeTierCard = tier.price === '$0' || tier.price === '€0' || tier.price === '0€' || tier.tierKey === 'free';
    const isCurrentPlan = isSameTier && (isSameBillingPeriod || isFreeTierCard);

    if (isCurrentPlan) {
      buttonText = t('currentPlan');
      buttonDisabled = true;
      statusBadge = null;
      ringClass = '';
    }
    else if (isRevenueCatSubscription && !isCurrentPlan) {
      buttonText = 'Manage in Mobile App';
      buttonDisabled = true;
      buttonVariant = 'outline';
      buttonClassName = 'opacity-70 cursor-not-allowed bg-muted text-muted-foreground';
    } else if (isCurrentActivePlan) {
      if (userPlanName === 'trial') {
        buttonText = t('trialActive');
        statusBadge = (
          <span className="bg-green-500/10 text-green-600 text-[10px] font-medium px-1.5 py-0.5 rounded-full">
            {t('trialBadge')}
          </span>
        );
      } else {
        buttonText = t('currentPlan');
        statusBadge = null;
      }
      buttonDisabled = true;
      buttonVariant = 'secondary';
      ringClass = 'ring-2 ring-primary';
      buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
    } else if (isScheduledTargetPlan) {
      buttonText = t('scheduled');
      buttonDisabled = true;
      buttonVariant = 'outline';
      ringClass = 'ring-2 ring-yellow-500';
      buttonClassName = 'bg-yellow-500/5 hover:bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      statusBadge = (
        <span className="bg-yellow-500/10 text-yellow-600 text-[10px] font-medium px-1.5 py-0.5 rounded-full">
          {t('scheduledBadge')}
        </span>
      );
    } else if (isScheduled && currentSubscription?.subscription.tier_key === tier.tierKey) {
      buttonText = t('changeScheduled');
      buttonVariant = 'secondary';
      ringClass = 'ring-2 ring-primary';
      buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
      statusBadge = (
        <span className="bg-yellow-500/10 text-yellow-600 text-[10px] font-medium px-1.5 py-0.5 rounded-full">
          {t('downgradePending')}
        </span>
      );
    } else {
      const currentPriceString = currentSubscription
        ? currentTier?.price || '$0'
        : '$0';
      const selectedPriceString = displayPrice;
      const currentAmount =
        parsePriceAmount(currentPriceString) === 0
          ? 0
          : parsePriceAmount(currentPriceString) * 100;
      const targetAmount =
        parsePriceAmount(selectedPriceString) === 0
          ? 0
          : parsePriceAmount(selectedPriceString) * 100;

      const isSameTierCheck = currentTier && currentTier.tierKey === tier.tierKey;
      const isBillingPeriodChange = isSameTierCheck && currentBillingPeriod !== billingPeriod;

      const isSameTierUpgradeToLongerTerm = isBillingPeriodChange && (
        (currentBillingPeriod === 'monthly' && (effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment')) ||
        (currentBillingPeriod === 'yearly' && effectiveBillingPeriod === 'yearly_commitment')
      );

      if (
        currentAmount === 0 &&
        targetAmount === 0 &&
        currentSubscription?.subscription.status !== 'no_subscription'
      ) {
        buttonText = t('selectPlan');
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
      } else if (!planChangeValidation.allowed) {
        buttonText = t('notAvailable');
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground';
      } else {
        if (targetAmount > currentAmount || isSameTierUpgradeToLongerTerm || isBillingPeriodChange) {
          if (isBillingPeriodChange && isSameTierCheck) {
            if (isSameTierUpgradeToLongerTerm) {
              buttonText = effectiveBillingPeriod === 'yearly_commitment' ? tCommon('upgrade') : 'Switch to Yearly';
            } else {
              buttonText = 'Switch to Monthly';
            }
            buttonVariant = 'default';
            buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
          } else if (isSameTierUpgradeToLongerTerm && targetAmount <= currentAmount) {
            buttonText = effectiveBillingPeriod === 'yearly_commitment' ? tCommon('upgrade') : t('switchToLegacyYearly');
            buttonVariant = effectiveBillingPeriod === 'yearly_commitment' ? tier.buttonColor as ButtonVariant : 'default';
            buttonClassName = effectiveBillingPeriod === 'yearly_commitment'
              ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
              : 'bg-green-600 hover:bg-green-700 text-white';
          } else {
            buttonText = tCommon('upgrade');
            buttonVariant = tier.buttonColor as ButtonVariant;
            buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
          }
        } else if (targetAmount < currentAmount) {
          buttonText = t('downgrade');
          buttonVariant = 'outline';
          buttonClassName = '';
          isDowngradeAction = true;
        } else {
          buttonText = t('selectPlan');
          buttonVariant = tier.buttonColor as ButtonVariant;
          buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
        }
      }
    }

    if (isPlanLoading) {
      buttonText = t('loading');
      buttonClassName = 'opacity-70 cursor-not-allowed';
    }
  } else {
    buttonVariant = tier.buttonColor as ButtonVariant;
    buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
  }

  const isUltraPlan = tier.name === 'Ultra';

  // Calculate annual savings in user's currency
  const calculateAnnualSavings = () => {
    if (isFreeTier) return null;

    if (effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment') {
      const monthlyPrice = parsePriceAmount(tier.price);
      const annualTotal = monthlyPrice * 12;
      const yearlyPrice = parsePriceAmount(tier.yearlyPrice || '0');

      if (yearlyPrice === 0) return null;

      const savings = annualTotal - yearlyPrice;
      return savings > 0 ? Math.round(savings) : null;
    }
    return null;
  };

  const annualSavings = calculateAnnualSavings();

  return (
    <div
      className={cn(
        'rounded-[14px] sm:rounded-[18px] flex flex-col relative overflow-hidden h-full',
        isFreeTier
          ? 'bg-muted/30 border border-border/50'
          : 'bg-card border border-border',
        ringClass
      )}
    >

      {/* AnimatedBg for Ultra plan */}
      {isUltraPlan && (
        <AnimatedBg
          variant="header"
          blurMultiplier={0.8}
          sizeMultiplier={0.7}
          customArcs={{
            left: [
              {
                pos: { left: -120, top: -30 },
                size: 350,
                tone: 'light',
                opacity: 0.15,
                delay: 0.02,
                x: [0, 12, -6, 0],
                y: [0, 8, -4, 0],
                scale: [0.85, 1.05, 0.95, 0.85],
                blur: ['10px', '15px', '12px', '10px'],
              },
            ],
            right: [
              {
                pos: { right: -110, top: 200 },
                size: 380,
                tone: 'dark',
                opacity: 0.2,
                delay: 1.0,
                x: [0, -15, 8, 0],
                y: [0, 10, -6, 0],
                scale: [0.9, 1.1, 0.98, 0.9],
                blur: ['8px', '4px', '6px', '8px'],
              },
            ],
          }}
        />
      )}

      <div className="flex flex-col gap-3 sm:gap-4 relative z-10 p-4 sm:p-5">
        {/* Header row: Badge + Popular chip */}
        <div className="flex items-center justify-between gap-2">
          <TierBadge planName={tier.name} size="lg" variant="default" />
          <div className="flex items-center gap-2">
            {isPopularHighlight && (
              <span className="text-[10px] sm:text-xs font-medium text-primary-foreground bg-primary px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-full">
                Most Popular
              </span>
            )}
            {isAuthenticated && statusBadge}
          </div>
        </div>

        {/* Price row */}
        <div className="flex items-baseline gap-2">
          <PriceDisplay price={displayPrice} />
          {(effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment') && !isFreeTier && (
            <>
              <span className="text-sm line-through text-muted-foreground">
                {formatPrice(parsePriceAmount(tier.price), currency)}
              </span>
              {annualSavings && annualSavings > 0 && (
                <span className="text-xs sm:text-sm font-medium text-green-600 dark:text-green-400">
                  Save {formatPrice(annualSavings, currency)}
                </span>
              )}
            </>
          )}
        </div>

        {/* Billing info - fixed height to prevent layout shift */}
        <div className="h-[18px] flex items-center">
          {!isFreeTier && (
            <span className="text-xs text-muted-foreground">
              {effectiveBillingPeriod === 'yearly' && tier.yearlyPrice
                ? `${convertPriceString(tier.yearlyPrice, currency)} billed annually`
                : t('perMonth')}
            </span>
          )}
        </div>
      </div>

      {/* Features */}
      <div className="flex-grow relative z-10 px-4 sm:px-5 pb-2 sm:pb-3">
        {tier.features && tier.features.length > 0 && (
          <ul className="space-y-2.5 sm:space-y-3">
            {tier.features.map((feature) => {
              // Handle bonus credits format
              if (feature.startsWith('CREDITS_BONUS:')) {
                const parts = feature.split(':');
                const originalCredits = parseInt(parts[1]).toLocaleString();
                const bonusCredits = parseInt(parts[2]).toLocaleString();
                return (
                  <li key={feature} className="flex items-start gap-2 sm:gap-3">
                    <div className="size-4 sm:size-5 min-w-4 sm:min-w-5 flex items-center justify-center mt-0.5">
                      <FeatureCheckIcon />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                        <span className="text-xs sm:text-sm text-muted-foreground line-through">{originalCredits}</span>
                        <span className="text-xs sm:text-sm font-bold text-foreground">{bonusCredits}</span>
                        <span className="text-xs sm:text-sm font-medium">Monthly Credits</span>
                        <Badge className="text-[9px] sm:text-[10px] px-1.5 sm:px-2 py-0.5 bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30">
                          2x BONUS
                        </Badge>
                      </div>
                      <span className="text-[10px] sm:text-xs text-muted-foreground hidden sm:block">Refreshes each billing cycle</span>
                    </div>
                  </li>
                );
              }

              // Handle custom AI Workers
              if (feature.includes('custom AI Workers')) {
                const match = feature.match(/(\d+)\s*custom AI Workers/);
                const description = feature.split(' - ')[1];
                if (match) {
                  return (
                    <li key={feature} className="flex items-start gap-2 sm:gap-3">
                      <div className="size-4 sm:size-5 min-w-4 sm:min-w-5 flex items-center justify-center mt-0.5">
                        <FeatureCheckIcon />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-1 sm:gap-1.5">
                          <span className="text-xs sm:text-sm font-medium">{match[1]} custom</span>
                          <KortixLogo size={12} variant="symbol" className="hidden sm:block" />
                          <span className="text-xs sm:text-sm font-medium">AI Workers</span>
                        </div>
                        {description && (
                          <span className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 hidden sm:block">{description}</span>
                        )}
                      </div>
                    </li>
                  );
                }
              }

              // Handle Kortix Advanced mode
              if (feature.includes('Advanced mode') || feature.includes('ADVANCED Mode')) {
                const description = feature.split(' - ')[1];
                return (
                  <li key={feature} className="flex items-start gap-2 sm:gap-3">
                    <div className="size-4 sm:size-5 min-w-4 sm:min-w-5 flex items-center justify-center mt-0.5">
                      <FeatureCheckIcon />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                        <span className="text-[10px] sm:text-xs text-muted-foreground/60 line-through">Basic</span>
                        <span className="text-muted-foreground/40 text-xs">→</span>
                        <span className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 bg-primary/10 dark:bg-primary/15 rounded-md">
                          <KortixLogo size={10} variant="symbol" className="sm:hidden" />
                          <KortixLogo size={12} variant="symbol" className="hidden sm:block" />
                          <span className="text-[10px] sm:text-xs font-semibold text-primary">Advanced</span>
                        </span>
                      </div>
                      {description && (
                        <span className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 hidden sm:block">{description}</span>
                      )}
                    </div>
                  </li>
                );
              }

              // Default feature rendering
              const featureParts = feature.split(' - ');
              const mainFeature = featureParts[0];
              const description = featureParts[1];

              return (
                <li key={feature} className="flex items-start gap-2 sm:gap-3">
                  <div className="size-4 sm:size-5 min-w-4 sm:min-w-5 flex items-center justify-center mt-0.5">
                    <FeatureCheckIcon />
                  </div>
                  <div className="flex-1">
                    <span className="text-xs sm:text-sm font-medium">{mainFeature}</span>
                    {description && (
                      <span className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 hidden sm:block">{description}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Disabled features for free tier */}
        {tier.disabledFeatures && tier.disabledFeatures.length > 0 && (
          <ul className="space-y-1.5 sm:space-y-2 mt-3 sm:mt-4 pt-3 sm:pt-4 border-t border-border/50">
            {tier.disabledFeatures.map((feature) => (
              <li key={feature} className="flex items-center gap-2 sm:gap-3 opacity-50">
                <X className="size-3.5 sm:size-4 text-muted-foreground" />
                <span className="text-xs sm:text-sm text-muted-foreground line-through">{feature}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Button */}
      <div className="mt-auto relative z-10 px-4 sm:px-5 pt-2 pb-4 sm:pb-5">
        <Button
          onClick={() => handleButtonClick(tier.tierKey, isDowngradeAction)}
          disabled={buttonDisabled}
          variant={buttonVariant || 'default'}
          className={cn(
            'w-full font-medium transition-all duration-200 h-10 sm:h-11 text-sm',
            buttonClassName,
            isPlanLoading && 'animate-pulse',
          )}
          title={!planChangeValidation.allowed ? (planChangeValidation as any).reason : undefined}
        >
          {buttonText}
        </Button>
      </div>

      {/* Downgrade Confirmation Dialog */}
      <DowngradeConfirmationDialog
        open={showConfirmDialog}
        onOpenChange={(open) => {
          setShowConfirmDialog(open);
          if (!open) {
            setPendingTierKey(null);
          }
        }}
        onConfirm={handleConfirmedDowngrade}
        targetPlanName={tier.name}
        isPending={scheduleDowngradeMutation.isPending}
      />

      {/* BorderBeam for Ultra plan */}
      {isUltraPlan && (
        <>
          <BorderBeam
            size={200}
            duration={12}
            delay={0}
            borderWidth={1.5}
            colorFrom="#23D3FF"
            colorTo="#FF1B07"
          />
          <BorderBeam
            size={200}
            duration={12}
            delay={0}
            borderWidth={1.5}
            colorFrom="#FFC78C"
            colorTo="#FDF5E0"
            initialOffset={50}
          />
        </>
      )}
    </div>
  );
}

// Basic tier card for bottom section
function BasicTierCard({
  tier,
  currentSubscription,
  isLoading,
  isFetchingPlan,
  onPlanSelect,
  onSubscriptionUpdate,
  isAuthenticated = false,
  returnUrl,
}: {
  tier: PricingTier;
  currentSubscription: AccountState | null;
  isLoading: Record<string, boolean>;
  isFetchingPlan: boolean;
  onPlanSelect?: (planId: string) => void;
  onSubscriptionUpdate?: () => void;
  isAuthenticated?: boolean;
  returnUrl: string;
}) {
  const t = useTranslations('billing');
  const scheduleDowngradeMutation = useScheduleDowngrade();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isSubscribing, setIsSubscribing] = useState(false);

  const isSameTier =
    currentSubscription?.subscription.tier_key === tier.tierKey ||
    currentSubscription?.tier?.name === tier.tierKey ||
    currentSubscription?.subscription.tier_display_name === tier.tierKey;

  const currentStatus = currentSubscription?.subscription.status;
  const isCurrentPlan = isAuthenticated && isSameTier &&
    (currentStatus === 'active' || currentStatus === 'trialing' || currentStatus === 'no_subscription');

  // Check if user is on a paid plan (can downgrade to basic)
  const isOnPaidPlan = isAuthenticated && !isSameTier &&
    currentSubscription?.subscription.tier_key &&
    currentSubscription.subscription.tier_key !== 'free' &&
    currentSubscription.subscription.tier_key !== 'none';

  const isPlanLoading = isLoading[tier.tierKey];

  const handleDowngrade = () => {
    setShowConfirmDialog(true);
  };

  const handleConfirmedDowngrade = () => {
    setShowConfirmDialog(false);
    scheduleDowngradeMutation.mutate({
      target_tier_key: tier.tierKey,
      commitment_type: 'monthly',
    }, {
      onSuccess: () => {
        posthog.capture('plan_downgrade_scheduled');
        if (onSubscriptionUpdate) onSubscriptionUpdate();
      },
    });
  };

  const handleSelectFreePlan = async () => {
    if (!isAuthenticated) {
      window.location.href = '/auth?mode=signup';
      return;
    }

    setIsSubscribing(true);
    onPlanSelect?.(tier.tierKey);

    try {
      const response = await createCheckoutSession({
        tier_key: tier.tierKey,
        success_url: `${window.location.origin}/dashboard?subscription=success`,
        cancel_url: returnUrl,
        commitment_type: 'monthly',
      } as CreateCheckoutSessionRequest);

      const checkoutUrl = response.checkout_url || response.url;

      switch (response.status) {
        case 'new':
        case 'checkout_created':
          // Free tier won't have a checkout URL - just redirect to dashboard
          if (checkoutUrl) {
            window.location.href = checkoutUrl;
          } else {
            posthog.capture('free_plan_selected');
            if (onSubscriptionUpdate) onSubscriptionUpdate();
            window.location.href = '/dashboard?subscription=success';
          }
          break;
        case 'upgraded':
        case 'updated':
          posthog.capture('free_plan_selected');
          if (onSubscriptionUpdate) onSubscriptionUpdate();
          window.location.href = '/dashboard?subscription=success';
          break;
        case 'no_change':
          toast.info(response.message || t('alreadyOnThisPlan'));
          break;
        default:
          toast.error(t('failedToInitiateSubscription'));
      }
    } catch (error: any) {
      const errorMessage = error?.response?.data?.detail || error?.message || 'Failed to select plan';
      toast.error(errorMessage);
    } finally {
      setIsSubscribing(false);
    }
  };

  let buttonText = 'Get started';
  let buttonDisabled = false;
  let buttonVariant: 'outline' | 'default' = 'outline';
  let onClickHandler: () => void = handleSelectFreePlan;

  if (isCurrentPlan) {
    buttonText = t('currentPlan');
    buttonDisabled = true;
  } else if (isOnPaidPlan) {
    buttonText = t('downgrade');
    onClickHandler = handleDowngrade;
  }

  if (isPlanLoading || scheduleDowngradeMutation.isPending || isSubscribing) {
    buttonText = t('loading');
    buttonDisabled = true;
  }

  return (
    <div className="rounded-[14px] sm:rounded-[18px] bg-muted/30 border border-border/50 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <TierBadge planName={tier.name} size="lg" variant="default" />
            <span className="text-sm text-muted-foreground font-medium">Free forever</span>
          </div>
          <p className="text-sm text-muted-foreground">{tier.description}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CheckIcon className="size-3.5 text-muted-foreground" />
              300 weekly credits
            </span>
            <span className="flex items-center gap-1.5">
              <CheckIcon className="size-3.5 text-muted-foreground" />
              1 concurrent run
            </span>
            <span className="flex items-center gap-1.5">
              <CheckIcon className="size-3.5 text-muted-foreground" />
              Basic Mode
            </span>
          </div>
        </div>
        <Button
          variant={buttonVariant}
          disabled={buttonDisabled}
          onClick={onClickHandler}
          className={cn(
            "min-w-[140px] h-10",
            isCurrentPlan && "bg-muted text-muted-foreground",
            (isPlanLoading || scheduleDowngradeMutation.isPending || isSubscribing) && "animate-pulse"
          )}
        >
          {buttonText}
        </Button>
      </div>

      {/* Downgrade Confirmation Dialog */}
      <DowngradeConfirmationDialog
        open={showConfirmDialog}
        onOpenChange={setShowConfirmDialog}
        onConfirm={handleConfirmedDowngrade}
        targetPlanName={tier.name}
        isPending={scheduleDowngradeMutation.isPending}
      />
    </div>
  );
}

interface PricingSectionProps {
  returnUrl?: string;
  showTitleAndTabs?: boolean;
  hideFree?: boolean;
  insideDialog?: boolean;
  noPadding?: boolean;
  onSubscriptionUpdate?: () => void;
  customTitle?: string;
  isAlert?: boolean;
  alertTitle?: string;
  alertSubtitle?: string;
  showBuyCredits?: boolean;
}

export function PricingSection({
  returnUrl = typeof window !== 'undefined' ? window.location.href : '/',
  showTitleAndTabs = true,
  hideFree = false,
  insideDialog = false,
  noPadding = false,
  onSubscriptionUpdate,
  customTitle,
  isAlert = false,
  alertTitle,
  alertSubtitle,
  showBuyCredits = false
}: PricingSectionProps) {
  const t = useTranslations('billing');
  const { user } = useAuth();
  const promo = usePromo();
  const [promoCodeCopied, setPromoCodeCopied] = useState(false);
  const promoCopyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();

  const { currency, symbol } = useUserCurrency();

  const { data: accountState, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useAccountState({ enabled: isUserAuthenticated });

  const isAuthenticated = isUserAuthenticated && !!accountState && subscriptionQueryError === null;

  const hasScheduledChange = accountState?.subscription.has_scheduled_change && accountState?.subscription.scheduled_change;
  const scheduledChange = accountState?.subscription.scheduled_change;
  const commitmentInfo = accountState?.subscription.commitment;
  const currentSubscription = accountState || null;

  const getCurrentBillingPeriod = (): 'monthly' | 'yearly' | 'yearly_commitment' | null => {
    if (!isAuthenticated || !currentSubscription) {
      return null;
    }

    if (currentSubscription.subscription.billing_period) {
      return currentSubscription.subscription.billing_period;
    }

    if ((currentSubscription as any).plan_type) {
      return (currentSubscription as any).plan_type;
    }

    if (commitmentInfo?.has_commitment &&
      commitmentInfo?.commitment_type === 'yearly_commitment') {
      return 'yearly_commitment';
    }

    if (currentSubscription.subscription?.current_period_end) {
      const periodEnd = typeof currentSubscription.subscription.current_period_end === 'number'
        ? currentSubscription.subscription.current_period_end * 1000
        : new Date(currentSubscription.subscription.current_period_end).getTime();

      const now = Date.now();
      const daysInPeriod = Math.round((periodEnd - now) / (1000 * 60 * 60 * 24));

      if (daysInPeriod > 180) {
        return 'yearly';
      }
    }

    return null;
  };

  const currentBillingPeriod = getCurrentBillingPeriod();

  const [planLoadingStates, setPlanLoadingStates] = useState<Record<string, boolean>>({});
  const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);

  useEffect(() => {
    return () => {
      if (promoCopyTimeoutRef.current) {
        clearTimeout(promoCopyTimeoutRef.current);
      }
    };
  }, []);

  // Global billing period toggle - starts as 'yearly' (Annual preselected)
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly' | 'yearly_commitment'>('yearly');

  // Get paid tiers (Plus, Pro, Ultra)
  const paidTiers = siteConfig.cloudPricingItems.filter(
    (tier) => !tier.hidden && tier.price !== '$0' && ['Plus', 'Pro', 'Ultra'].includes(tier.name)
  );
  const freeTier = siteConfig.cloudPricingItems.find((tier) => tier.price === '$0');

  const handlePlanSelect = (planId: string) => {
    setPlanLoadingStates((prev) => ({ ...prev, [planId]: true }));
  };

  const calculatePriceForBillingPeriod = useCallback((tier: PricingTier, period: string): number => {
    const basePrice = parsePriceAmount(tier.price || '$0');
    if (period === 'yearly_commitment') {
      return Math.round(basePrice * 12 * 0.85);
    } else if (period === 'yearly' && tier.yearlyPrice) {
      return Math.round(parsePriceAmount(tier.yearlyPrice));
    }
    return basePrice;
  }, []);

  const buildPlanItemData = useCallback((tier: PricingTier, period: string): PlanItemData => {
    const priceAmount = calculatePriceForBillingPeriod(tier, period);
    const billingLabel = period === 'monthly' ? 'Monthly' : 'Yearly';
    return {
      item_id: `${tier.tierKey}_${period}`,
      item_name: `${tier.name} ${billingLabel}`,
      item_brand: 'Kortix AI',
      item_category: 'Plans',
      item_list_id: 'plans_listing',
      item_list_name: 'Plans Listing',
      price: priceAmount,
      quantity: 1,
    };
  }, [calculatePriceForBillingPeriod]);

  // Track view_item on mount
  const hasTrackedViewRef = React.useRef(false);
  React.useEffect(() => {
    if (!hasTrackedViewRef.current && paidTiers.length > 0) {
      const proTier = paidTiers.find(t => t.name === 'Pro') || paidTiers[0];
      const itemData = buildPlanItemData(proTier, billingPeriod);
      const priceAmount = calculatePriceForBillingPeriod(proTier, billingPeriod);
      trackViewItem(itemData, currency, priceAmount);
      hasTrackedViewRef.current = true;
    }
  }, [paidTiers, billingPeriod, currency, buildPlanItemData, calculatePriceForBillingPeriod]);

  const handleBillingPeriodChange = useCallback((period: 'monthly' | 'yearly' | 'yearly_commitment') => {
    setBillingPeriod(period);
    if (paidTiers.length > 0) {
      const proTier = paidTiers.find(t => t.name === 'Pro') || paidTiers[0];
      const itemData = buildPlanItemData(proTier, period);
      const priceAmount = calculatePriceForBillingPeriod(proTier, period);
      trackSelectItem(itemData);
      trackViewItem(itemData, currency, priceAmount);
    }
  }, [paidTiers, currency, buildPlanItemData, calculatePriceForBillingPeriod]);

  const handlePromoCopy = useCallback(async () => {
    if (!promo?.isActive || !promo.promoCode) {
      return;
    }
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard not available');
      }
      await navigator.clipboard.writeText(promo.promoCode);
      setPromoCodeCopied(true);
      toast.success(`Promo code ${promo.promoCode} copied to clipboard`);
      if (promoCopyTimeoutRef.current) {
        clearTimeout(promoCopyTimeoutRef.current);
      }
      promoCopyTimeoutRef.current = setTimeout(() => setPromoCodeCopied(false), 2000);
    } catch (error) {
      toast.error('Failed to copy promo code');
    }
  }, [promo?.isActive, promo?.promoCode]);

  const handleSubscriptionUpdate = () => {
    setTimeout(() => {
      setPlanLoadingStates({});
    }, 1000);
    if (onSubscriptionUpdate) {
      onSubscriptionUpdate();
    }
  };

  if (isLocalMode()) {
    return (
      <div className="p-4 bg-muted/30 border border-border rounded-lg text-center">
        <p className="text-sm text-muted-foreground">
          {t('localModeMessage')}
        </p>
      </div>
    );
  }

  const isYearly = billingPeriod === 'yearly' || billingPeriod === 'yearly_commitment';

  return (
    <section
      id="pricing"
      className={cn("flex flex-col items-center justify-center w-full relative", noPadding ? "pb-0" : "pb-12")}
    >
      <div className="w-full mx-auto px-4 sm:px-6 flex flex-col">
        {/* Header */}
        <div className="w-full max-w-5xl mx-auto mb-4 sm:mb-6 sm:pt-4">
          {/* Title + Toggle Row */}
          {showTitleAndTabs && (
            <div className="mb-4 sm:mb-5">
              {isAlert ? (
                <div className="flex flex-col gap-4 items-center text-center">
                  <div className="flex flex-col gap-2">
                    <h2 className="text-2xl sm:text-3xl lg:text-4xl font-semibold tracking-tight text-foreground">
                      {alertTitle || t('limitReachedUpgrade')}
                    </h2>
                    {alertSubtitle && (
                      <p className="text-base sm:text-lg text-muted-foreground">
                        {alertSubtitle}
                      </p>
                    )}
                  </div>
                  {/* Monthly/Yearly Toggle for Alert mode */}
                  <div className="inline-flex items-center bg-muted/50 rounded-full pl-4 py-2" style={{ paddingRight: isYearly ? '8px' : '16px', transition: 'padding-right 200ms ease' }}>
                    <span className={cn(
                      "text-sm font-medium transition-colors w-16 text-center",
                      !isYearly ? "text-foreground" : "text-muted-foreground"
                    )}>Monthly</span>
                    <button
                      onClick={() => handleBillingPeriodChange(isYearly ? 'monthly' : 'yearly')}
                      className={cn(
                        "relative w-14 h-7 rounded-full transition-colors duration-200 mx-3",
                        isYearly
                          ? "bg-foreground"
                          : "bg-muted-foreground/30"
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-1 left-1 w-5 h-5 rounded-full shadow-md transition-transform duration-200 bg-background",
                          isYearly && "translate-x-7"
                        )}
                      />
                    </button>
                    <span className={cn(
                      "text-sm font-medium transition-colors w-14 text-center",
                      isYearly ? "text-foreground" : "text-muted-foreground"
                    )}>Annual</span>
                    <div
                      className="overflow-hidden transition-all duration-200 ease-out"
                      style={{ width: isYearly ? '78px' : '0px', marginLeft: isYearly ? '8px' : '0px' }}
                    >
                      <Badge className="text-xs font-medium whitespace-nowrap bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30">
                        Save 15%
                      </Badge>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <h2 className="text-2xl pb-2 sm:pb-0 sm:text-3xl font-semibold tracking-tight">
                    {customTitle || 'Pick the plan that works for you.'}
                  </h2>
                  {/* Monthly/Yearly Toggle */}
                  <div className="self-start sm:self-auto inline-flex items-center bg-muted/50 rounded-full pl-4 py-2" style={{ paddingRight: isYearly ? '8px' : '16px', transition: 'padding-right 200ms ease' }}>
                    <span className={cn(
                      "text-sm font-medium transition-colors w-16 text-center",
                      !isYearly ? "text-foreground" : "text-muted-foreground"
                    )}>Monthly</span>
                    <button
                      onClick={() => handleBillingPeriodChange(isYearly ? 'monthly' : 'yearly')}
                      className={cn(
                        "relative w-14 h-7 rounded-full transition-colors duration-200 mx-3",
                        isYearly
                          ? "bg-foreground"
                          : "bg-muted-foreground/30"
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-1 left-1 w-5 h-5 rounded-full shadow-md transition-transform duration-200 bg-background",
                          isYearly && "translate-x-7"
                        )}
                      />
                    </button>
                    <span className={cn(
                      "text-sm font-medium transition-colors w-14 text-center",
                      isYearly ? "text-foreground" : "text-muted-foreground"
                    )}>Annual</span>
                    <div
                      className="overflow-hidden transition-all duration-200 ease-out"
                      style={{ width: isYearly ? '78px' : '0px', marginLeft: isYearly ? '8px' : '0px' }}
                    >
                      <Badge className="text-xs font-medium whitespace-nowrap bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30">
                        Save 15%
                      </Badge>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Standalone Toggle when showTitleAndTabs is false */}
          {!showTitleAndTabs && (
            <div className="flex items-center justify-center mb-4 sm:mb-6">
              <div className="inline-flex items-center bg-muted/50 rounded-full pl-4 py-2" style={{ paddingRight: isYearly ? '8px' : '16px', transition: 'padding-right 200ms ease' }}>
                <span className={cn(
                  "text-sm font-medium transition-colors w-16 text-center",
                  !isYearly ? "text-foreground" : "text-muted-foreground"
                )}>Monthly</span>
                <button
                  onClick={() => handleBillingPeriodChange(isYearly ? 'monthly' : 'yearly')}
                  className={cn(
                    "relative w-14 h-7 rounded-full transition-colors duration-200 mx-3",
                    isYearly
                      ? "bg-foreground"
                      : "bg-muted-foreground/30"
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-1 left-1 w-5 h-5 rounded-full shadow-md transition-transform duration-200 bg-background",
                      isYearly && "translate-x-7"
                    )}
                  />
                </button>
                <span className={cn(
                  "text-sm font-medium transition-colors w-14 text-center",
                  isYearly ? "text-foreground" : "text-muted-foreground"
                )}>Annual</span>
                <div
                  className="overflow-hidden transition-all duration-200 ease-out"
                  style={{ width: isYearly ? '78px' : '0px', marginLeft: isYearly ? '8px' : '0px' }}
                >
                  <Badge className="text-xs font-medium whitespace-nowrap bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30">
                    Save 15%
                  </Badge>
                </div>
              </div>
            </div>
          )}

          {/* Promo Banner */}
          {(() => {
            const isFreeTierUser = !isAuthenticated || !accountState?.subscription ||
              accountState.subscription.tier_key === 'free' ||
              accountState.subscription.tier_key === 'none' ||
              (accountState.tier?.monthly_credits ?? 0) === 0;

            const showPromo = promo?.isActive && isFreeTierUser;

            if (!showPromo) return null;

            return (
              <div className="mb-6 sm:mb-8">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-2xl border border-dashed border-primary/30 bg-primary/5 px-4 py-3 sm:px-6 sm:py-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                      <Gift className="h-3.5 w-3.5" />
                      {promo.badgeLabel}
                      <span className="flex items-center gap-1 text-muted-foreground tracking-normal normal-case">
                        <Timer className="h-3.5 w-3.5" />
                        {promo.timeLabel}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {promo.promoCode === 'KORTIX26'
                        ? `Use code ${promo.promoCode} to get 30% off for the first three months + 2X credits as welcome bonus`
                        : promo.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm tracking-[0.35em] px-4 h-9 flex items-center rounded-full bg-primary text-primary-foreground">
                      {promo.promoCode}
                    </span>
                    <Button
                      size="icon"
                      onClick={handlePromoCopy}
                      className="h-9 w-9 rounded-full"
                    >
                      {promoCodeCopied ? <CheckIcon className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Scheduled Downgrade Alert */}
        {isAuthenticated && hasScheduledChange && scheduledChange && (
          <div className="w-full max-w-5xl mx-auto mb-6">
            <ScheduledDowngradeCard
              scheduledChange={scheduledChange}
              variant="compact"
              onCancel={handleSubscriptionUpdate}
            />
          </div>
        )}

        {/* 3 Paid Plans Grid */}
        <div className="w-full max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 mb-6 sm:mb-8">
            {paidTiers.map((tier) => (
              <PricingCard
                key={tier.name}
                tier={tier}
                currentSubscription={currentSubscription}
                isLoading={planLoadingStates}
                isFetchingPlan={isFetchingPlan}
                onPlanSelect={handlePlanSelect}
                onSubscriptionUpdate={handleSubscriptionUpdate}
                isAuthenticated={isAuthenticated}
                returnUrl={returnUrl}
                billingPeriod={billingPeriod}
                currentBillingPeriod={currentBillingPeriod}
                isPopularHighlight={tier.isPopular}
              />
            ))}
          </div>

          {/* Basic Tier at Bottom */}
          {freeTier && !hideFree && (
            <BasicTierCard
              tier={freeTier}
              currentSubscription={currentSubscription}
              isLoading={planLoadingStates}
              isFetchingPlan={isFetchingPlan}
              onPlanSelect={handlePlanSelect}
              onSubscriptionUpdate={handleSubscriptionUpdate}
              isAuthenticated={isAuthenticated}
              returnUrl={returnUrl}
            />
          )}
        </div>

        {/* Get Additional Credits Button */}
        {showBuyCredits &&
          isAuthenticated &&
          currentSubscription?.subscription.can_purchase_credits && (
            <div className="w-full max-w-5xl mx-auto mt-12 pb-8 flex flex-col items-center gap-4">
              <Button
                onClick={() => setShowCreditPurchaseModal(true)}
                variant="outline"
                size="lg"
                className="gap-2"
              >
                <ShoppingCart className="h-5 w-5" />
                {t('getAdditionalCredits')}
              </Button>
              <Button
                variant="link"
                asChild
                className="text-muted-foreground hover:text-foreground h-auto p-0"
              >
                <Link href="/credits-explained" target="_blank" rel="noopener noreferrer">
                  <Lightbulb className="h-3.5 w-3.5 mr-2" />
                  <span className="text-sm">{t('creditsExplained')}</span>
                </Link>
              </Button>
            </div>
          )}

        {/* Credits Explained Link */}
        {(!isAuthenticated || !currentSubscription?.subscription.can_purchase_credits) && (
          <div className="w-full max-w-5xl mx-auto mt-8 pb-8 flex justify-center">
            <Button
              variant="link"
              asChild
              className="text-muted-foreground hover:text-foreground h-auto p-0"
            >
              <Link href="/credits-explained" target="_blank" rel="noopener noreferrer">
                <Lightbulb className="h-3.5 w-3.5 mr-2" />
                <span className="text-sm">{t('creditsExplained')}</span>
              </Link>
            </Button>
          </div>
        )}
      </div>

      {/* Credit Purchase Modal */}
      <CreditPurchaseModal
        open={showCreditPurchaseModal}
        onOpenChange={setShowCreditPurchaseModal}
        currentBalance={currentSubscription?.credits.total || 0}
        canPurchase={currentSubscription?.subscription.can_purchase_credits || false}
        onPurchaseComplete={handleSubscriptionUpdate}
      />
    </section>
  );
}
