'use client';

import type { PricingTier } from '@/lib/pricing-config';
import { siteConfig } from '@/lib/home';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import React, { useState, useEffect, useCallback } from 'react';
import NextImage from 'next/image';
import {
  CheckIcon,
  ShoppingCart,
  Lightbulb,
  X,
  RotateCcw
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
const FeatureCheckIcon = () => <CheckIcon className="size-4 text-primary" />;

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
  
  const isFreeTier = tier.price === '$0';
  const effectiveBillingPeriod = isFreeTier ? 'monthly' : billingPeriod;
  const isYearly = effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment';

  // Determine the price to display based on billing period
  const getDisplayPrice = () => {
    // For $0 plans, always show $0
    if (tier.price === '$0') {
      return '$0';
    }

    if (effectiveBillingPeriod === 'yearly_commitment') {
      const regularPrice = parseFloat(tier.price.slice(1));
      const discountedPrice = Math.round(regularPrice * 0.85);
      console.log(`[${tier.name}] Yearly Commitment: $${regularPrice} -> $${discountedPrice}`);
      return `$${discountedPrice}`;
    } else if (effectiveBillingPeriod === 'yearly' && tier.yearlyPrice) {
      const yearlyTotal = tier.yearlyPrice;
      const monthlyEquivalent = Math.round(parseFloat(yearlyTotal.slice(1)) / 12);
      console.log(`[${tier.name}] Yearly: ${yearlyTotal} (${monthlyEquivalent}/mo)`);
      return `$${monthlyEquivalent}`;
    }

    console.log(`[${tier.name}] Monthly: ${tier.price}`);
    return tier.price;
  };

  const displayPrice = getDisplayPrice();

  const scheduleDowngradeMutation = useScheduleDowngrade();

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
            queryClient.invalidateQueries({ queryKey: accountStateKeys.all });
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
        } as CreateCheckoutSessionRequest);

      switch (response.status) {
        case 'new':
        case 'checkout_created':
        case 'commitment_created':
          if (response.url) {
            posthog.capture('plan_purchase_attempted');
            window.location.href = response.url;
          } else {
            console.error(
              "Error: Received status but no checkout URL.",
            );
            toast.error(t('failedToInitiateSubscription'));
          }
          break;
        case 'upgraded':
        case 'updated':
          posthog.capture('plan_upgraded');
          queryClient.invalidateQueries({ queryKey: accountStateKeys.all });
          if (onSubscriptionUpdate) onSubscriptionUpdate();
          // Always redirect with success param to trigger celebration
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
          // Invalidate queries to show scheduled change
          queryClient.invalidateQueries({ queryKey: accountStateKeys.all });
          // Trigger subscription update callback to refetch data
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
    const isFreeTierCard = tier.price === '$0' || tier.tierKey === 'free';
    const isCurrentPlan = isSameTier && (isSameBillingPeriod || isFreeTierCard);
    
    if (isCurrentPlan) {
      buttonText = t('currentPlan');
      buttonDisabled = true;
      statusBadge = <Badge variant="default" className="text-xs">{t('currentBadge')}</Badge>;
      ringClass = '';
    }
    else if (isRevenueCatSubscription && !isCurrentPlan) {
      buttonText = 'Manage in App';
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
        statusBadge = (
          <span className="bg-primary/10 text-primary text-[10px] font-medium px-1.5 py-0.5 rounded-full">
            Current{isRevenueCatSubscription ? ' (Mobile)' : ''}
          </span>
        );
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
        currentPriceString === '$0'
          ? 0
          : parseFloat(currentPriceString.replace(/[^\d.]/g, '') || '0') * 100;
      const targetAmount =
        selectedPriceString === '$0'
          ? 0
          : parseFloat(selectedPriceString.replace(/[^\d.]/g, '') || '0') * 100;

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

  // Calculate annual savings
  const calculateAnnualSavings = () => {
    if (isFreeTier) return null;
    // Calculate savings for yearly billing
    if (effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment') {
      const monthlyPrice = parseFloat(tier.price.slice(1));
      const annualTotal = monthlyPrice * 12;
      const yearlyPrice = parseFloat(tier.yearlyPrice?.slice(1) || '0');
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
        'rounded-[18px] flex flex-col relative overflow-hidden h-full',
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
        "flex flex-col gap-3 relative z-10",
        insideDialog ? "p-3" : "p-4"
      )}>
        {/* Header row: Badge + SAVE badge */}
        <div className="flex items-center justify-between gap-2 min-h-[36px]">
          <TierBadge planName={tier.name} size="lg" variant="default" />
          <div className="flex items-center gap-2 min-w-[100px] justify-end">
            {annualSavings ? (
              <Badge className="bg-green-500/15 text-green-600 dark:text-green-400 border-2 border-green-500/30 text-sm font-bold px-3 py-1.5 shadow-sm">
                SAVE ${annualSavings}
              </Badge>
            ) : !isFreeTier ? (
              <div className="h-[32px]" />
            ) : null}
            {isAuthenticated && statusBadge}
          </div>
        </div>
        
        {/* Price row - fixed height to prevent layout shift */}
        <div className="flex items-center justify-between min-h-[60px]">
          <div className="flex flex-col min-h-[50px] justify-center min-w-[120px]">
            <div className="flex items-baseline gap-2">
              <PriceDisplay price={displayPrice} isCompact={insideDialog} />
              {(effectiveBillingPeriod === 'yearly' || effectiveBillingPeriod === 'yearly_commitment') && displayPrice !== '$0' && (
                <span className="text-xs line-through text-muted-foreground">
                  ${tier.price.slice(1)}
                </span>
              )}
            </div>
            <div className="h-[18px] flex items-center mt-1">
              {effectiveBillingPeriod === 'yearly_commitment' && displayPrice !== '$0' ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">{t('perMonth')}</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">12mo</Badge>
                </div>
              ) : effectiveBillingPeriod === 'yearly' && tier.yearlyPrice && displayPrice !== '$0' ? (
                <span className="text-xs text-muted-foreground">{tier.yearlyPrice} billed annually</span>
              ) : displayPrice !== '$0' ? (
                <span className="text-xs text-muted-foreground">{t('perMonth')}</span>
              ) : null}
            </div>
          </div>
          
          {/* Annual toggle - only for paid tiers */}
          {!isFreeTier ? (
            <div className="flex items-center gap-2.5 bg-muted/50 rounded-full px-3 py-1.5">
              <span className={cn(
                "text-sm transition-colors",
                !isYearly ? "text-foreground font-medium" : "text-muted-foreground"
              )}>Monthly</span>
              <button
                onClick={() => onBillingPeriodChange?.(isYearly ? 'monthly' : 'yearly')}
                className={cn(
                  "relative w-12 h-6 rounded-full transition-colors duration-200",
                  isYearly 
                    ? "bg-primary" 
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

      <div className={cn(
        "flex-grow relative z-10",
        insideDialog ? "px-3 pb-2" : "px-4 pb-3"
      )}>
        {tier.features && tier.features.length > 0 && (
          <ul className="space-y-3">
              {tier.features.map((feature) => {
              // Handle daily credits
              if (feature.includes('daily credits')) {
                const match = feature.match(/(\d+)\s*daily credits/);
                const description = feature.split(' - ')[1];
                return (
                  <li key={feature} className="flex items-start gap-3">
                    <div className="size-5 min-w-5 flex items-center justify-center mt-0.5">
                      <RotateCcw className="size-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{match?.[1] || '200'} Daily Credits</span>
                      </div>
                      {description && (
                        <span className="text-xs text-muted-foreground block mt-0.5">{description}</span>
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
                  <li key={feature} className="flex items-start gap-3">
                    <div className="size-5 min-w-5 flex items-center justify-center mt-0.5">
                      <FeatureCheckIcon />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-muted-foreground line-through">{originalCredits}</span>
                        <span className="text-sm font-bold text-primary">{bonusCredits}</span>
                        <span className="text-sm font-medium">Monthly Credits</span>
                        <Badge className="text-[10px] px-2 py-0.5 bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30">
                          2x BONUS
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">Refreshes each billing cycle</span>
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
                    <li key={feature} className="flex items-start gap-3">
                      <div className="size-5 min-w-5 flex items-center justify-center mt-0.5">
                        <FeatureCheckIcon />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium">{match[1]} custom</span>
                          <KortixLogo size={14} variant="symbol" />
                          <span className="text-sm font-medium">AI Workers</span>
                        </div>
                        {description && (
                          <span className="text-xs text-muted-foreground block mt-0.5">{description}</span>
                        )}
                      </div>
                    </li>
                  );
                }
              }
              
              // Special handling for Kortix Power mode - show with Basic crossed out
              if (feature.includes('Power mode') || feature.includes('POWER Mode')) {
                const description = feature.split(' - ')[1];
                return (
                  <li key={feature} className="flex items-start gap-3">
                    <div className="size-5 min-w-5 flex items-center justify-center mt-0.5">
                      <FeatureCheckIcon />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground/60 line-through">Basic</span>
                        <span className="text-muted-foreground/40">→</span>
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-primary/10 dark:bg-primary/15 rounded-md">
                          <KortixLogo size={12} variant="symbol" />
                          <span className="text-xs font-semibold text-primary">Power</span>
                        </span>
                      </div>
                      {description && (
                        <span className="text-xs text-muted-foreground block mt-0.5">{description}</span>
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
                    <li key={feature} className="flex items-start gap-3">
                      <div className="size-5 min-w-5 flex items-center justify-center mt-0.5">
                        <FeatureCheckIcon />
                      </div>
                      <div className="flex-1">
                        <span className="text-sm font-medium">{creditsCount} Monthly Credits</span>
                        <span className="text-xs text-muted-foreground block mt-0.5">Refreshes each billing cycle</span>
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
              } else if (feature.includes('Power mode') || feature.includes('POWER Mode')) {
                translatedFeature = 'Kortix Power mode';
              } else if (feature.includes('Priority Support') || feature === 'Priority Support') {
                translatedFeature = t('features.prioritySupport');
              }
              
              // Split feature into main text and description if it contains " - "
              const featureParts = translatedFeature.split(' - ');
              const mainFeature = featureParts[0];
              const description = featureParts[1];

              return (
                <li key={feature} className="flex items-start gap-3">
                  <div className="size-5 min-w-5 flex items-center justify-center mt-0.5">
                    <FeatureCheckIcon />
                  </div>
                  <div className="flex-1">
                    <span className="text-sm font-medium">{mainFeature}</span>
                    {description && (
                      <span className="text-xs text-muted-foreground block mt-0.5">{description}</span>
                    )}
                  </div>
                </li>
              );
              })}
            </ul>
        )}
        {/* Show disabled features for free tier */}
        {tier.disabledFeatures && tier.disabledFeatures.length > 0 && (
          <ul className="space-y-2 mt-4 pt-4 border-t border-border/50">
            {tier.disabledFeatures.map((feature) => (
              <li key={feature} className="flex items-center gap-3 opacity-50">
                <X className="size-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground line-through">{feature}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={cn(
        "mt-auto relative z-10",
        insideDialog ? "px-3 pt-1 pb-3" : "px-4 pt-2 pb-4"
      )}>
        <Button
          onClick={() => handleSubscribe(tier.tierKey, isDowngradeAction)}
          disabled={buttonDisabled}
          variant={buttonVariant || 'default'}
          className={cn(
            'w-full font-medium transition-all duration-200',
            isCompact || insideDialog ? 'h-8 text-xs' : 'h-10 text-sm',
            buttonClassName,
            isPlanLoading && 'animate-pulse',
          )}
          title={!planChangeValidation.allowed ? (planChangeValidation as any).reason : undefined}
        >
          {buttonText}
        </Button>
      </div>

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
  alertTitle
}: PricingSectionProps) {
  const t = useTranslations('billing');
  const { user } = useAuth();
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();

  const { data: accountState, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useAccountState({ enabled: isUserAuthenticated });

  const isAuthenticated = isUserAuthenticated && !!accountState && subscriptionQueryError === null;
  
  // Get scheduled change and commitment from account state
  const hasScheduledChange = accountState?.subscription.has_scheduled_change && accountState?.subscription.scheduled_change;
  const scheduledChange = accountState?.subscription.scheduled_change;
  const commitmentInfo = accountState?.subscription.commitment;
  const currentSubscription = accountState || null;

  const getCurrentBillingPeriod = (): 'monthly' | 'yearly' | 'yearly_commitment' | null => {
    if (!isAuthenticated || !currentSubscription) {
      console.log(`[BILLING-PERIOD-DEBUG] No auth or subscription: auth=${isAuthenticated}, sub=${!!currentSubscription}`);
      return null;
    }
    
    console.log(`[BILLING-PERIOD-DEBUG] Current subscription billing_period:`, currentSubscription.subscription.billing_period);
    console.log(`[BILLING-PERIOD-DEBUG] Current subscription plan_type:`, (currentSubscription as any).plan_type);
    
    // Check API billing_period field first
    if (currentSubscription.subscription.billing_period) {
      console.log(`[BILLING-PERIOD-DEBUG] Using API billing_period: ${currentSubscription.subscription.billing_period}`);
      return currentSubscription.subscription.billing_period;
    }
    
    // Check plan_type field as backup
    if ((currentSubscription as any).plan_type) {
      const planType = (currentSubscription as any).plan_type;
      console.log(`[BILLING-PERIOD-DEBUG] Using API plan_type: ${planType}`);
      return planType;
    }

    if (commitmentInfo?.has_commitment &&
      commitmentInfo?.commitment_type === 'yearly_commitment') {
      console.log(`[BILLING-PERIOD-DEBUG] Using commitment from subscription: yearly_commitment`);
      return 'yearly_commitment';
    }

    // Fallback: Try to infer from period length
    if (currentSubscription.subscription?.current_period_end) {
      const periodEnd = typeof currentSubscription.subscription.current_period_end === 'number'
        ? currentSubscription.subscription.current_period_end * 1000
        : new Date(currentSubscription.subscription.current_period_end).getTime();

      const now = Date.now();
      const daysInPeriod = Math.round((periodEnd - now) / (1000 * 60 * 60 * 24));

      console.log(`[BILLING-PERIOD-DEBUG] Period length detection: ${daysInPeriod} days`);

      // If period is longer than 180 days, likely yearly; otherwise monthly
      if (daysInPeriod > 180) {
        console.log(`[BILLING-PERIOD-DEBUG] Inferred yearly from period length`);
        return 'yearly';
      }
    }

    // Default to monthly if period is short or can't determine
    console.log(`[BILLING-PERIOD-DEBUG] Defaulting to monthly`);
    return 'monthly';
  };

  const currentBillingPeriod = getCurrentBillingPeriod();

  const getDefaultBillingPeriod = useCallback((): 'monthly' | 'yearly' | 'yearly_commitment' => {
    if (!isAuthenticated || !currentSubscription) {
      return 'yearly_commitment';
    }
    if (currentBillingPeriod) {
      console.log(`[BILLING-PERIOD-DEBUG] Using detected billing period: ${currentBillingPeriod}`);
      return currentBillingPeriod;
    }
    console.log(`[BILLING-PERIOD-DEBUG] No billing period detected, defaulting to yearly_commitment`);
    return 'yearly_commitment';
  }, [isAuthenticated, currentSubscription, currentBillingPeriod]);

  const [planLoadingStates, setPlanLoadingStates] = useState<Record<string, boolean>>({});
  const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);
  
  // Shared billing period state across all pricing tiers
  const [sharedBillingPeriod, setSharedBillingPeriod] = useState<'monthly' | 'yearly' | 'yearly_commitment'>(() => {
    return currentBillingPeriod || getDefaultBillingPeriod();
  });
  
  // Plan switcher state for paid tiers
  const paidTiers = siteConfig.cloudPricingItems.filter(
    (tier) => !tier.hidden && tier.price !== '$0' && ['Plus', 'Pro', 'Ultra'].includes(tier.name)
  );
  const freeTier = siteConfig.cloudPricingItems.find((tier) => tier.price === '$0');
  
  // Find the index of the user's current tier to pre-select it
  const getCurrentTierIndex = () => {
    if (!isAuthenticated || !currentSubscription) return 0;
    const currentTierKey = currentSubscription.subscription.tier_key || currentSubscription.tier?.name;
    const index = paidTiers.findIndex(tier => tier.tierKey === currentTierKey);
    return index >= 0 ? index : 0;
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

  const handleSubscriptionUpdate = () => {
    // Invalidate all billing-related queries to force refetch
    queryClient.invalidateQueries({ queryKey: accountStateKeys.all });
    // Refetch subscription directly (now includes scheduled changes and commitment)
    refetchSubscription();
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
      className={cn("flex flex-col items-center justify-center w-full relative", noPadding ? "pb-0" : "pb-12")}
    >
      <div className="w-full mx-auto px-6 flex flex-col">
        {/* Header Row: Title on left, Plan Switcher on right */}
        <div className="w-full max-w-6xl mx-auto flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
          {/* Title - Left aligned */}
          <div className="flex-shrink-0">
            {isAlert ? (
              <h2 className="text-2xl lg:text-3xl font-medium tracking-tight text-foreground">
                {alertTitle || t('pickPlan')}
              </h2>
            ) : showTitleAndTabs ? (
              <div className="flex flex-col gap-1.5">
                <h2 className="text-2xl lg:text-3xl font-medium tracking-tight">
                  {customTitle || t('pickPlan')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  <span className="font-semibold text-primary">LIMITED TIME</span>
                  <span className="mx-1.5">·</span>
                  Subscribe now & get <span className="font-medium text-foreground">2X credits</span>
                </p>
              </div>
            ) : null}
          </div>
          
          {/* Plan Switcher Tabs - Right aligned */}
          {paidTiers.length > 0 && (
            <div className="flex justify-start lg:justify-end gap-2">
              {paidTiers.map((tier, index) => (
                <button
                  key={tier.name}
                  onClick={() => setSelectedPaidTierIndex(index)}
                  className={cn(
                    "px-4 py-2 rounded-full font-medium text-sm transition-all duration-200",
                    selectedPaidTierIndex === index
                      ? "bg-primary text-primary-foreground shadow-lg"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {tier.name}
                  {tier.price && (
                    <span className="ml-1.5 opacity-70">{tier.price}/mo</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Scheduled Downgrade Alert - Show above pricing tiers */}
        {isAuthenticated && hasScheduledChange && scheduledChange && (
          <div className="w-full max-w-6xl mx-auto mb-6">
            <ScheduledDowngradeCard
              scheduledChange={scheduledChange}
              variant="compact"
              onCancel={() => {
                refetchSubscription();
              }}
            />
          </div>
        )}
        
        {/* Main Layout: Free tier (1/4) | Paid tier (3/4) side by side */}
        <div className="w-full max-w-6xl mx-auto flex flex-col lg:flex-row gap-6 lg:items-stretch">
          {/* Free Tier - 1/4 width on desktop */}
          {freeTier && !hideFree && (
            <div className="w-full lg:w-1/4 lg:min-w-[260px] flex flex-col">
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

