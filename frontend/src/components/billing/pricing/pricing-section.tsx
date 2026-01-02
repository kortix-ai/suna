'use client';

import type { PricingTier } from '@/lib/pricing-config';
import { siteConfig } from '@/lib/site-config';
import { storeCheckoutData } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import React, { useState, useEffect, useCallback } from 'react';
import NextImage from 'next/image';
import {
  CheckIcon,
  ShoppingCart,
  Lightbulb,
  X,
  RotateCcw,
  Copy,
  Gift,
  Timer,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AccountState } from '@/lib/api/billing';
import { createCheckoutSession, CreateCheckoutSessionRequest, CreateCheckoutSessionResponse } from '@/lib/api/billing';
import { toast } from 'sonner';
import { isLocalMode } from '@/lib/config';
import { useAccountState, useScheduleDowngrade, accountStateKeys, accountStateSelectors } from '@/hooks/billing';
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

interface PricingTierProps {
  tier: PricingTier;
  isCompact?: boolean;
  currentSubscription: AccountState | null;
  isLoading: Record<string, boolean>;
  isFetchingPlan: boolean;
  selectedPlan?: string;
  onPlanSelect?: (planId: string) => void;
  onSubscriptionUpdate?: () => void;
  isAuthenticated?: boolean;
  returnUrl: string;
  insideDialog?: boolean;
  billingPeriod?: 'monthly' | 'yearly' | 'yearly_commitment';
}

// All enabled features use CheckIcon for consistency
const FeatureCheckIcon = () => <CheckIcon className="size-3.5 sm:size-4 text-primary" />;

// Components

function PriceDisplay({ price, isCompact }: PriceDisplayProps) {
  return (
    <motion.span
      key={price}
      className={isCompact ? 'text-xl font-medium' : 'text-[48px] font-medium leading-none'}
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

function PricingTier({
  tier,
  isCompact = false,
  currentSubscription,
  isLoading,
  isFetchingPlan,
  selectedPlan,
  onPlanSelect,
  onSubscriptionUpdate,
  isAuthenticated = false,
  returnUrl,
  insideDialog = false,
  billingPeriod = 'monthly' as 'monthly' | 'yearly' | 'yearly_commitment',
  onBillingPeriodChange,
  currentBillingPeriod = null as 'monthly' | 'yearly' | 'yearly_commitment' | null,
}: PricingTierProps & {
  currentBillingPeriod?: 'monthly' | 'yearly' | 'yearly_commitment' | null;
  onBillingPeriodChange?: (period: 'monthly' | 'yearly' | 'yearly_commitment') => void;
}) {
  const t = useTranslations('billing');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  
  // Add currency detection
  const { currency, symbol } = useUserCurrency();
  // Get locale for Stripe adaptive pricing
  const { locale } = useLanguage();

  const isFreeTier = tier.price === '$0' || tier.price === '€0' || tier.price === '0€';
  const effectiveBillingPeriod = isFreeTier ? 'monthly' : billingPeriod;
  const isYearly = effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment';

  // Determine the price to display based on billing period AND currency
  const getDisplayPrice = () => {
    // For $0 plans, always show 0 with user's currency symbol
    if (tier.price === '$0') {
      return currency === 'EUR' ? '0€' : '$0';
    }

    let basePrice = tier.price;

    // Calculate price based on billing period
    if (effectiveBillingPeriod === 'yearly_commitment') {
      const regularPrice = parsePriceAmount(tier.price);
      const discountedPrice = Math.round(regularPrice * 0.85);
      basePrice = `$${discountedPrice}`;
    } else if (effectiveBillingPeriod === 'yearly' && tier.yearlyPrice) {
      const yearlyTotal = tier.yearlyPrice;
      const monthlyEquivalent = Math.round(parsePriceAmount(yearlyTotal) / 12);
      basePrice = `$${monthlyEquivalent}`;
    }

    // Convert to user's currency
    return convertPriceString(basePrice, currency);
  };

  const displayPrice = getDisplayPrice();

  const scheduleDowngradeMutation = useScheduleDowngrade();

  // Confirmation modal state for downgrades
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

    try {
      onPlanSelect?.(tierKey);
      const commitmentType = effectiveBillingPeriod === 'yearly_commitment' ? 'yearly_commitment' :
        effectiveBillingPeriod === 'yearly' ? 'yearly' :
          'monthly';


      if (isDowngrade) {
        scheduleDowngradeMutation.mutate({
          target_tier_key: tierKey,
          commitment_type: commitmentType,
        }, {
          onSuccess: () => {
            posthog.capture('plan_downgrade_scheduled');
            // Note: invalidateAccountState is already called by the mutation hook
          },
          onSettled: () => {
            // Always clear loading state when mutation completes (success or error)
            if (onSubscriptionUpdate) onSubscriptionUpdate();
          }
        });
        return;
      }

      const response: CreateCheckoutSessionResponse =
        await createCheckoutSession({
          tier_key: tierKey,
          success_url: `${window.location.origin}/dashboard?subscription=success`,
          cancel_url: returnUrl,
          commitment_type: commitmentType,
          locale: locale, // Pass locale for Stripe adaptive pricing
        } as CreateCheckoutSessionRequest);

      // Handle checkout URL - support both checkout_url and url fields
      const checkoutUrl = response.checkout_url || response.url;

      switch (response.status) {
        case 'new':
        case 'checkout_created':
        case 'commitment_created':
          if (checkoutUrl) {
            // Store checkout data for GTM purchase tracking after Stripe redirect
            const priceAmount = parsePriceAmount(displayPrice);
            storeCheckoutData({
              tier_key: tierKey,
              tier_name: tier.name,
              price: priceAmount,
              currency: currency,
              billing_period: effectiveBillingPeriod,
            });
            posthog.capture('plan_purchase_attempted');
            window.location.href = checkoutUrl;
          } else {
            console.error(
              "Error: Received status but no checkout URL.",
            );
            toast.error(t('failedToInitiateSubscription'));
          }
          break;
        case 'upgraded':
        case 'updated':
          // Store checkout data for GTM purchase tracking
          const upgradePriceAmount = parsePriceAmount(displayPrice);
          storeCheckoutData({
            tier_key: tierKey,
            tier_name: tier.name,
            price: upgradePriceAmount,
            currency: currency,
            billing_period: effectiveBillingPeriod,
          });
          posthog.capture('plan_upgraded');
          if (onSubscriptionUpdate) onSubscriptionUpdate();
          // Redirect to dashboard which will handle cache invalidation
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
                console.error(`[BILLING] Invalid date value: ${dateValue}`);
                effectiveDate = 'end of billing period';
              }
            } catch (e) {
              console.error(`[BILLING] Error parsing date: ${e}`);
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
              <p className="text-sm mt-1">
                {planChangeDate}
              </p>
            </div>,
          );
          posthog.capture('plan_downgraded');
          // Note: Cache invalidation is handled by the calling context
          // Just trigger UI update callback
          if (onSubscriptionUpdate) onSubscriptionUpdate();
          break;
        case 'no_change':
          toast.info(response.message || t('alreadyOnThisPlan'));
          break;
        default:
          console.warn(
            'Received unexpected status from createCheckoutSession:',
            response.status,
          );
          toast.error('An unexpected error occurred. Please try again.');
      }
    } catch (error: any) {
      console.error('Error processing subscription:', error);
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

  // More robust current plan detection
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
    // Free tier has no billing period, so it's always "current" if user is on free tier
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
      ringClass = isCompact ? 'ring-1 ring-primary' : 'ring-2 ring-primary';
      buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
    } else if (isScheduledTargetPlan) {
      buttonText = t('scheduled');
      buttonDisabled = true;
      buttonVariant = 'outline';
      ringClass = isCompact
        ? 'ring-1 ring-yellow-500'
        : 'ring-2 ring-yellow-500';
      buttonClassName =
        'bg-yellow-500/5 hover:bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      statusBadge = (
        <span className="bg-yellow-500/10 text-yellow-600 text-[10px] font-medium px-1.5 py-0.5 rounded-full">
          {t('scheduledBadge')}
        </span>
      );
    } else if (isScheduled && currentSubscription?.subscription.tier_key === tier.tierKey) {
      buttonText = t('changeScheduled');
      buttonVariant = 'secondary';
      ringClass = isCompact ? 'ring-1 ring-primary' : 'ring-2 ring-primary';
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

      const isSameTier = currentTier && currentTier.tierKey === tier.tierKey;

      const isBillingPeriodChange = isSameTier && currentBillingPeriod !== billingPeriod;

      const isSameTierUpgradeToLongerTerm = isBillingPeriodChange && (
        (currentBillingPeriod === 'monthly' && (effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment')) ||
        (currentBillingPeriod === 'yearly' && effectiveBillingPeriod === 'yearly_commitment')
      );

      const isYearlyDowngradeToMonthly = false;
      const isSameTierDowngradeToShorterTerm = false;

      if (
        currentAmount === 0 &&
        targetAmount === 0 &&
        currentSubscription?.subscription.status !== 'no_subscription'
      ) {
        buttonText = t('selectPlan');
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
      } else if (isYearlyDowngradeToMonthly) {
        buttonText = t('notAvailable');
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground';
      } else if (!planChangeValidation.allowed) {
        buttonText = t('notAvailable');
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground';
      } else {
        if (targetAmount > currentAmount || isSameTierUpgradeToLongerTerm || isBillingPeriodChange) {
          if (isBillingPeriodChange && isSameTier) {
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
        } else if (targetAmount < currentAmount || isSameTierDowngradeToShorterTerm) {
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
    // Non-authenticated state styling
    buttonVariant = tier.buttonColor as ButtonVariant;
    buttonClassName =
      tier.buttonColor === 'default'
        ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
        : 'bg-primary hover:bg-primary/90 text-primary-foreground';
  }

  const isUltraPlan = tier.name === 'Ultra';
  const isPaidTier = !isFreeTier;

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
        !insideDialog && ringClass,
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

      <div className={cn(
        "flex flex-col gap-2 sm:gap-3 relative z-10",
        insideDialog ? "p-2.5 sm:p-3" : "p-3 sm:p-4"
      )}>
        {/* Header row: Badge + SAVE badge + Price - all in one row on mobile */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3">
            <TierBadge planName={tier.name} size="lg" variant="default" />
            {/* Price inline on mobile */}
            <div className="flex items-baseline gap-1.5 sm:hidden">
              <span className="text-2xl font-medium">{displayPrice}</span>
              {(effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment') && !isFreeTier && (
                <span className="text-[10px] line-through text-muted-foreground">
                  {formatPrice(parsePriceAmount(tier.price), currency)}
                </span>
              )}
              {!isFreeTier && (
                <span className="text-[10px] text-muted-foreground">/mo</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            {annualSavings ? (
              <Badge className="bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30 sm:border-2 text-[10px] sm:text-sm font-bold px-1.5 sm:px-3 py-0.5 sm:py-1.5 shadow-sm">
                SAVE {formatPrice(annualSavings, currency)}
              </Badge>
            ) : null}
            {isAuthenticated && statusBadge}
            {/* Billing toggle - desktop only, on the right */}
            {!isFreeTier ? (
              <div className="hidden sm:flex items-center gap-2.5 bg-muted/50 rounded-full px-3 py-1.5">
                <span className={cn(
                  "text-sm transition-colors",
                  !isYearly ? "text-foreground font-medium" : "text-muted-foreground"
                )}>Monthly</span>
                <button
                  onClick={() => onBillingPeriodChange?.(isYearly ? 'monthly' : 'yearly')}
                  className={cn(
                    "relative w-12 h-6 rounded-full transition-colors duration-200",
                    isYearly
                      ? "bg-black dark:bg-white"
                      : "bg-zinc-300 dark:bg-zinc-600"
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200",
                      isYearly && "translate-x-6"
                    )}
                  />
                </button>
                <span className={cn(
                  "text-sm transition-colors",
                  isYearly ? "text-foreground font-medium" : "text-muted-foreground"
                )}>Annual</span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Price row - desktop only */}
        <div className="hidden sm:flex items-center justify-between min-h-[60px]">
          <div className="flex flex-col min-h-[50px] justify-center min-w-[120px]">
            <div className="flex items-baseline gap-2">
              <PriceDisplay price={displayPrice} isCompact={insideDialog} />
              {(effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment') && !isFreeTier && (
                <span className="text-xs line-through text-muted-foreground">
                  {formatPrice(parsePriceAmount(tier.price), currency)}
                </span>
              )}
            </div>
            <div className="h-[18px] flex items-center mt-1">
              {effectiveBillingPeriod === 'yearly_commitment' && !isFreeTier ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">{t('perMonth')}</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">12mo</Badge>
                </div>
              ) : effectiveBillingPeriod === 'yearly' && tier.yearlyPrice && !isFreeTier ? (
                <span className="text-xs text-muted-foreground">
                  {convertPriceString(tier.yearlyPrice, currency)} billed annually
                </span>
              ) : !isFreeTier ? (
                <span className="text-xs text-muted-foreground">{t('perMonth')}</span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Mobile billing toggle - matches desktop style */}
        {!isFreeTier && (
          <div className="flex sm:hidden items-center justify-center">
            <div className="flex items-center gap-2 bg-muted/50 rounded-full px-2.5 py-1.5">
              <span className={cn(
                "text-xs transition-colors",
                !isYearly ? "text-foreground font-medium" : "text-muted-foreground"
              )}>Monthly</span>
              <button
                onClick={() => onBillingPeriodChange?.(isYearly ? 'monthly' : 'yearly')}
                className={cn(
                  "relative w-10 h-5 rounded-full transition-colors duration-200",
                  isYearly
                    ? "bg-black dark:bg-white"
                    : "bg-zinc-300 dark:bg-zinc-600"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200",
                    isYearly && "translate-x-5"
                  )}
                />
              </button>
              <span className={cn(
                "text-xs transition-colors",
                isYearly ? "text-foreground font-medium" : "text-muted-foreground"
              )}>Annual</span>
              {effectiveBillingPeriod === 'yearly_commitment' && !isFreeTier && (
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0 ml-1">12mo</Badge>
              )}
            </div>
          </div>
        )}
      </div>

      <div className={cn(
        "flex-grow relative z-10",
        insideDialog ? "px-2.5 sm:px-3 pb-1 sm:pb-2" : "px-3 sm:px-4 pb-2 sm:pb-3"
      )}>
        {tier.features && tier.features.length > 0 && (
          <ul className="space-y-2 sm:space-y-3">
              {tier.features.map((feature) => {
              // Handle daily credits
              if (feature.includes('daily credits')) {
                const match = feature.match(/(\d+)\s*daily credits/);
                const description = feature.split(' - ')[1];
                return (
                  <li key={feature} className="flex items-start gap-2 sm:gap-3">
                    <div className="size-4 sm:size-5 min-w-4 sm:min-w-5 flex items-center justify-center mt-0.5">
                      <RotateCcw className="size-3.5 sm:size-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5">
                      <span className="text-xs sm:text-sm font-medium">{match?.[1] || '100'} Daily Credits</span>
                      </div>
                      {description && (
                        <span className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 hidden sm:block">{description}</span>
                      )}
                    </div>
                  </li>
                );
              }

              // Handle bonus credits format: "CREDITS_BONUS:2000:4000"
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
                        <span className="text-xs sm:text-sm font-bold text-primary">{bonusCredits}</span>
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

              // Special handling for custom AI Workers - show with description
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

              // Special handling for Kortix Advanced mode - show with Basic crossed out
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

              // Handle credits/month
              if (feature.includes('credits/month')) {
                const match = feature.match(/(\d+[,\d]*)\s*credits\/month/);
                if (match) {
                  const creditsCount = match[1];
                  return (
                    <li key={feature} className="flex items-start gap-2 sm:gap-3">
                      <div className="size-4 sm:size-5 min-w-4 sm:min-w-5 flex items-center justify-center mt-0.5">
                        <FeatureCheckIcon />
                      </div>
                      <div className="flex-1">
                        <span className="text-xs sm:text-sm font-medium">{creditsCount} Monthly Credits</span>
                        <span className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 hidden sm:block">Refreshes each billing cycle</span>
                      </div>
                    </li>
                  );
                }
              }

              // Translate feature strings
              let translatedFeature = feature;

              // Match and translate common patterns
              if (feature.includes('private project')) {
                const match = feature.match(/(\d+)\s*private\s+project/);
                if (match) {
                  const count = parseInt(match[1]);
                  translatedFeature = count === 1
                    ? t('features.privateProject', { count })
                    : t('features.privateProjects');
                }
              } else if (feature === 'Private projects') {
                translatedFeature = t('features.privateProjects');
              } else if (feature.includes('custom trigger')) {
                const match = feature.match(/(\d+)\s*custom\s+trigger/);
                if (match) {
                  const count = parseInt(match[1]);
                  translatedFeature = t('features.customTrigger', { count });
                }
              } else if (feature.includes('100+ integrations') || feature === '100+ integrations' || feature.includes('100+ App Integrations')) {
                translatedFeature = t('features.integrations');
              } else if (feature.includes('Advanced mode') || feature.includes('ADVANCED Mode')) {
                translatedFeature = 'Kortix Advanced mode';
              } else if (feature.includes('Priority Support') || feature === 'Priority Support') {
                translatedFeature = t('features.prioritySupport');
              }

              // Split feature into main text and description if it contains " - "
              const featureParts = translatedFeature.split(' - ');
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
        {/* Show disabled features for free tier */}
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

      <div className={cn(
        "mt-auto relative z-10",
        insideDialog ? "px-2.5 sm:px-3 pt-1 pb-2.5 sm:pb-3" : "px-3 sm:px-4 pt-1.5 sm:pt-2 pb-3 sm:pb-4"
      )}>
        <Button
          onClick={() => handleButtonClick(tier.tierKey, isDowngradeAction)}
          disabled={buttonDisabled}
          variant={buttonVariant || 'default'}
          className={cn(
            'w-full font-medium transition-all duration-200',
            isCompact || insideDialog ? 'h-8 text-xs' : 'h-9 sm:h-10 text-xs sm:text-sm',
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

      {/* BorderBeam for Ultra plan only - dual tracers in sync */}
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
  alertSubtitle
}: PricingSectionProps) {
  const t = useTranslations('billing');
  const { user } = useAuth();
  const promo = usePromo();
  const [promoCodeCopied, setPromoCodeCopied] = useState(false);
  const promoCopyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();
  
  // Add currency detection at top level
  const { currency, symbol } = useUserCurrency();

  const { data: accountState, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useAccountState({ enabled: isUserAuthenticated });

  const isAuthenticated = isUserAuthenticated && !!accountState && subscriptionQueryError === null;

  // Get scheduled change and commitment from account state
  const hasScheduledChange = accountState?.subscription.has_scheduled_change && accountState?.subscription.scheduled_change;
  const scheduledChange = accountState?.subscription.scheduled_change;
  const commitmentInfo = accountState?.subscription.commitment;
  const currentSubscription = accountState || null;

  /**
   * Detects the current billing period from the user's subscription.
   * Returns null if user is not authenticated or no subscription exists.
   */
  const getCurrentBillingPeriod = (): 'monthly' | 'yearly' | 'yearly_commitment' | null => {
    if (!isAuthenticated || !currentSubscription) {
      return null;
    }

    // Check API billing_period field first (most reliable)
    if (currentSubscription.subscription.billing_period) {
      return currentSubscription.subscription.billing_period;
    }

    // Check plan_type field as backup
    if ((currentSubscription as any).plan_type) {
      return (currentSubscription as any).plan_type;
    }

    // Check for yearly commitment
    if (commitmentInfo?.has_commitment &&
      commitmentInfo?.commitment_type === 'yearly_commitment') {
      return 'yearly_commitment';
    }

    // Fallback: Try to infer from period length
    if (currentSubscription.subscription?.current_period_end) {
      const periodEnd = typeof currentSubscription.subscription.current_period_end === 'number'
        ? currentSubscription.subscription.current_period_end * 1000
        : new Date(currentSubscription.subscription.current_period_end).getTime();

      const now = Date.now();
      const daysInPeriod = Math.round((periodEnd - now) / (1000 * 60 * 60 * 24));

      // If period is longer than 180 days, likely yearly; otherwise monthly
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

  // Billing period toggle state - ALWAYS starts as 'yearly' (Annual preselected)
  const [sharedBillingPeriod, setSharedBillingPeriod] = useState<'monthly' | 'yearly' | 'yearly_commitment'>('yearly');

  // Plan switcher state for paid tiers
  const paidTiers = siteConfig.cloudPricingItems.filter(
    (tier) => !tier.hidden && tier.price !== '$0' && ['Plus', 'Pro', 'Ultra'].includes(tier.name)
  );
  const freeTier = siteConfig.cloudPricingItems.find((tier) => tier.price === '$0');

  // Find the index of the user's current tier to pre-select it
  const getCurrentTierIndex = () => {
    if (!isAuthenticated || !currentSubscription) return 1; // Default to Pro plan (index 1)
    const currentTierKey = currentSubscription.subscription.tier_key || currentSubscription.tier?.name;
    const index = paidTiers.findIndex(tier => tier.tierKey === currentTierKey);
    return index >= 0 ? index : 1; // Default to Pro plan (index 1) if tier not found
  };

  const [selectedPaidTierIndex, setSelectedPaidTierIndex] = useState(getCurrentTierIndex);
  const selectedPaidTier = paidTiers[selectedPaidTierIndex] || null;

  // Update selected tier when subscription data loads
  React.useEffect(() => {
    if (isAuthenticated && currentSubscription) {
      const currentTierKey = currentSubscription.subscription.tier_key || currentSubscription.tier?.name;
      const index = paidTiers.findIndex(tier => tier.tierKey === currentTierKey);
      if (index >= 0) {
        setSelectedPaidTierIndex(index);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, currentSubscription?.subscription.tier_key, currentSubscription?.tier?.name]);

  const handlePlanSelect = (planId: string) => {
    setPlanLoadingStates((prev) => ({ ...prev, [planId]: true }));
  };

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
      console.error('Failed to copy promo code', error);
      toast.error('Failed to copy promo code');
    }
  }, [promo?.isActive, promo?.promoCode]);

  const handleSubscriptionUpdate = () => {
    // Note: Cache invalidation is handled by mutation hooks (useScheduleDowngrade, etc.)
    // This function just handles UI state updates

    // Clear loading states
    setTimeout(() => {
      setPlanLoadingStates({});
    }, 1000);
    // Call parent's update handler if provided
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

  const isRevenueCatUser = isAuthenticated && currentSubscription?.subscription.provider === 'revenuecat';

  return (
    <section
      id="pricing"
      className={cn("scale-90 flex flex-col items-center justify-center w-full relative", noPadding ? "pb-0" : "pb-12")}
    >
      <div className="w-full mx-auto px-4 sm:px-6 flex flex-col">
        {/* Compact Header for Mobile */}
        <div className="w-full max-w-6xl mx-auto mb-3 sm:mb-6">
          {/* Title Row */}
          <div className="flex items-center justify-between gap-2 mb-2 sm:mb-4">
            <div className="flex-shrink-0">
              {isAlert ? (
                <div className="flex flex-col gap-1">
                  <h2 className="text-lg sm:text-2xl lg:text-3xl font-medium tracking-tight text-foreground">
                    {alertTitle || t('pickPlan')}
                  </h2>
                  {alertSubtitle && (
                    <p className="text-sm sm:text-base text-muted-foreground">
                      {alertSubtitle}
                    </p>
                  )}
                </div>
              ) : showTitleAndTabs ? (
                <h2 className="text-lg sm:text-2xl lg:text-3xl font-medium tracking-tight">
                  {customTitle || t('pickPlan')}
                </h2>
              ) : null}
            </div>

            {/* Desktop Plan Switcher - Hidden on mobile */}
            {paidTiers.length > 0 && (
              <div className="hidden lg:flex justify-end gap-2">
                {paidTiers.map((tier, index) => (
                  <button
                    key={tier.name}
                    onClick={() => setSelectedPaidTierIndex(index)}
                    className={cn(
                      "pl-1 pr-2 py-1 rounded-full font-medium text-sm transition-all duration-200 flex items-center gap-2",
                      selectedPaidTierIndex === index
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <TierBadge planName={tier.name} size="sm" variant="default" />
                    {tier.price && (
                      <span className="opacity-70">{convertPriceString(tier.price, currency)}/mo</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>

        {(() => {
          // Only show holiday promo for FREE tier users (not authenticated or on free tier)
          const isFreeTier = !isAuthenticated || !accountState || 
            accountState.subscription.tier_key === 'free' || 
            accountState.subscription.tier_key === 'none' ||
            (accountState.tier?.monthly_credits ?? 0) === 0;
          
          return promo?.isActive && isFreeTier && (
            <div className="w-full max-w-6xl mx-auto mb-3 sm:mb-6">
              <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-primary/30 bg-primary/5 px-4 py-3 sm:px-6 sm:py-4 md:flex-row md:items-center md:justify-between">
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
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                  <span className="font-mono text-sm tracking-[0.35em] px-4 py-2 rounded-full bg-primary text-primary-foreground shadow-sm">
                    {promo.promoCode}
                  </span>
                  <button
                    type="button"
                    onClick={handlePromoCopy}
                    className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-background/90 dark:bg-background/50 px-3 py-1.5 text-xs font-medium text-primary shadow-sm transition hover:bg-background"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {promoCodeCopied ? 'Copied!' : 'Copy Code'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Scheduled Downgrade Alert - Show above pricing tiers */}
        {isAuthenticated && hasScheduledChange && scheduledChange && (
          <div className="w-full max-w-6xl mx-auto mb-3 sm:mb-6">
            <ScheduledDowngradeCard
              scheduledChange={scheduledChange}
              variant="compact"
              onCancel={handleSubscriptionUpdate}
            />
          </div>
        )}

        {/* Main Layout: Free tier (1/4) | Paid tier (3/4) side by side */}
        <div className="w-full max-w-6xl mx-auto flex flex-col lg:flex-row gap-3 sm:gap-6 lg:items-stretch">
          {/* Free Tier - 1/4 width on desktop, hidden on mobile when inside dialog */}
          {freeTier && !hideFree && (
            <div className={cn(
              "w-full lg:w-1/4 lg:min-w-[260px] flex flex-col",
              insideDialog && "hidden lg:flex"
            )}>
              <div className="flex-1">
                <PricingTier
                  key={freeTier.name}
                  tier={freeTier}
                  currentSubscription={currentSubscription}
                  isLoading={planLoadingStates}
                  isFetchingPlan={isFetchingPlan}
                  onPlanSelect={handlePlanSelect}
                  onSubscriptionUpdate={handleSubscriptionUpdate}
                  isAuthenticated={isAuthenticated}
                  returnUrl={returnUrl}
                  insideDialog={insideDialog}
                  billingPeriod={sharedBillingPeriod}
                  onBillingPeriodChange={setSharedBillingPeriod}
                  currentBillingPeriod={currentBillingPeriod}
                />
              </div>
            </div>
          )}

          {/* Paid Tiers - 3/4 width on desktop */}
          {paidTiers.length > 0 && (
            <div className="w-full lg:w-3/4 flex flex-col">
              {/* Mobile Plan Switcher - Above the card */}
              {paidTiers.length > 0 && (
                <div className="flex lg:hidden justify-center gap-1 mb-3 p-1 bg-muted/40 rounded-full">
                  {paidTiers.map((tier, index) => (
                    <button
                      key={tier.name}
                      onClick={() => setSelectedPaidTierIndex(index)}
                      className={cn(
                        "flex-1 pl-1 pr-2 py-1 rounded-full font-medium text-xs transition-all duration-200 flex items-center justify-center gap-1.5",
                        selectedPaidTierIndex === index
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <TierBadge planName={tier.name} size="xs" variant="default" />
                      <span className="opacity-80">{convertPriceString(tier.price, currency)}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Selected Paid Plan */}
              <div className="flex-1">
                {selectedPaidTier && (
                  <PricingTier
                    key={selectedPaidTier.name}
                    tier={selectedPaidTier}
                    currentSubscription={currentSubscription}
                    isLoading={planLoadingStates}
                    isFetchingPlan={isFetchingPlan}
                    onPlanSelect={handlePlanSelect}
                    onSubscriptionUpdate={handleSubscriptionUpdate}
                    isAuthenticated={isAuthenticated}
                    returnUrl={returnUrl}
                    insideDialog={insideDialog}
                    billingPeriod={sharedBillingPeriod}
                    onBillingPeriodChange={setSharedBillingPeriod}
                    currentBillingPeriod={currentBillingPeriod}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Get Additional Credits Button - Only visible if tier allows credit purchases */}
        {isAuthenticated &&
          currentSubscription?.subscription.can_purchase_credits && (
            <div className="w-full max-w-6xl mt-12 flex flex-col items-center gap-4">
              <Button
                onClick={() => setShowCreditPurchaseModal(true)}
                variant="outline"
                size="lg"
                className="gap-2"
              >
                <ShoppingCart className="h-5 w-5" />
                {t('getAdditionalCredits')}
              </Button>
              {/* Credits Explained Link */}
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

        {/* Credits Explained Link - Show when not authenticated or when credits purchase is not available */}
        {(!isAuthenticated || !currentSubscription?.subscription.can_purchase_credits) && (
          <div className="w-full max-w-6xl mt-8 flex justify-center">
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

