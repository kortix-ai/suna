'use client';

import type { PricingTier } from '@/lib/home';
import { siteConfig } from '@/lib/home';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import React, { useState, useEffect, useCallback } from 'react';
import NextImage from 'next/image';
import {
  CheckIcon,
  Clock,
  Bot,
  FileText,
  Settings,
  Grid3X3,
  Image,
  Video,
  Presentation,
  Diamond,
  Heart,
  Zap,
  ShoppingCart,
  Lightbulb,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SubscriptionInfo } from '@/lib/api/billing';
import { createCheckoutSession, CreateCheckoutSessionRequest, CreateCheckoutSessionResponse } from '@/lib/api/billing';
import { toast } from 'sonner';
import { isLocalMode } from '@/lib/config';
import { useSubscription, useScheduleDowngrade } from '@/hooks/billing';
import { useSubscriptionCommitment } from '@/hooks/billing';
import { useAuth } from '@/components/AuthProvider';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/hooks/billing/use-subscription';
import posthog from 'posthog-js';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { TierBadge } from '@/components/billing/tier-badge';
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
  currentSubscription: SubscriptionInfo | null;
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

// Feature icon mapping
const getFeatureIcon = (feature: string) => {
  const featureLower = feature.toLowerCase();

  if (featureLower.includes('token credits') || featureLower.includes('ai token')) {
    return <Clock className="size-4" />;
  }
  if (featureLower.includes('custom workers') || featureLower.includes('agents')) {
    return <Bot className="size-4" />;
  }
  if (featureLower.includes('private projects') || featureLower.includes('public projects')) {
    return <FileText className="size-4" />;
  }
  if (featureLower.includes('integrations') || featureLower.includes('100+')) {
    return <Grid3X3 className="size-4" />;
  }
  if (featureLower.includes('premium ai models')) {
    return <Diamond className="size-4" />;
  }
  if (featureLower.includes('community support') || featureLower.includes('priority support')) {
    return <Heart className="size-4" />;
  }
  if (featureLower.includes('image') || featureLower.includes('video') || featureLower.includes('slides') || featureLower.includes('generation')) {
    return <Image className="size-4" />;
  }
  if (featureLower.includes('dedicated account manager')) {
    return <Zap className="size-4" />;
  }

  // Default icon
  return <CheckIcon className="size-4" />;
};

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

function BillingPeriodToggle({
  billingPeriod,
  setBillingPeriod,
  setHasUserToggledBillingPeriod
}: {
  billingPeriod: 'monthly' | 'yearly' | 'yearly_commitment';
  setBillingPeriod: (period: 'monthly' | 'yearly' | 'yearly_commitment') => void;
  setHasUserToggledBillingPeriod: (toggled: boolean) => void;
}) {
  const t = useTranslations('billing');

  return (
    <div className="flex flex-col items-center justify-center w-full gap-4">
      <div className="flex gap-2 items-center flex-wrap justify-center">
        <Button
          variant={billingPeriod === 'monthly' ? 'default' : 'outline'}
          onClick={() => {
            setHasUserToggledBillingPeriod(true);
            setBillingPeriod('monthly');
          }}
          className={cn(
            "border-[1.5px]",
            billingPeriod === 'monthly' ? 'border-primary' : 'border-border'
          )}
        >
          {t('monthly')}
        </Button>
        <Button
          variant={billingPeriod === 'yearly' ? 'default' : 'outline'}
          onClick={() => {
            setHasUserToggledBillingPeriod(true);
            setBillingPeriod('yearly');
          }}
          className={cn(
            "flex items-center gap-1.5 border-[1.5px]",
            billingPeriod === 'yearly' ? 'border-primary' : 'border-border'
          )}
        >
          {t('yearly')}
          <span className={cn(
            "px-1.5 py-0.5 rounded-full text-xs font-medium",
            billingPeriod === 'yearly'
              ? "bg-background/90 text-primary"
              : "bg-muted/80 text-primary dark:bg-muted"
          )}>
            15% OFF
          </span>
        </Button>
      </div>
      <div className="text-xs text-muted-foreground text-center max-w-2xl">
        {billingPeriod === 'monthly' && 'Pay monthly, get credits monthly. Cancel anytime.'}
        {billingPeriod === 'yearly' && 'Pay upfront for the year, get credits monthly. 15% discount. Cancel anytime, effective at period end.'}
      </div>
    </div>
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
  currentBillingPeriod = null as 'monthly' | 'yearly' | 'yearly_commitment' | null,
}: PricingTierProps & { currentBillingPeriod?: 'monthly' | 'yearly' | 'yearly_commitment' | null }) {
  const t = useTranslations('billing');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();

  // Determine the price to display based on billing period
  const getDisplayPrice = () => {
    // For $0 plans, always show $0
    if (tier.price === '$0') {
      return '$0';
    }

    if (billingPeriod === 'yearly_commitment') {
      const regularPrice = parseFloat(tier.price.slice(1));
      const discountedPrice = Math.round(regularPrice * 0.85);
      console.log(`[${tier.name}] Yearly Commitment: $${regularPrice} -> $${discountedPrice}`);
      return `$${discountedPrice}`;
    } else if (billingPeriod === 'yearly' && tier.yearlyPrice) {
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
      const commitmentType = billingPeriod === 'yearly_commitment' ? 'yearly_commitment' :
        billingPeriod === 'yearly' ? 'yearly' :
          'monthly';
      

      if (isDowngrade) {
        scheduleDowngradeMutation.mutate({
          target_tier_key: tierKey,
          commitment_type: commitmentType,
        }, {
          onSuccess: () => {
            posthog.capture('plan_downgrade_scheduled');
            queryClient.invalidateQueries({ queryKey: billingKeys.all });
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
          const upgradeMessage = response.details?.is_upgrade
            ? t('subscriptionUpgraded', { 
                currentPrice: `$${response.details.current_price}`, 
                newPrice: `$${response.details.new_price}` 
              })
            : t('subscriptionUpdated');
          toast.success(upgradeMessage);
          posthog.capture('plan_upgraded');
          queryClient.invalidateQueries({ queryKey: billingKeys.all });
          if (onSubscriptionUpdate) onSubscriptionUpdate();
          if (response.redirect_to_dashboard) {
            setTimeout(() => {
              window.location.href = '/dashboard';
            }, 1000);
          }
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
          queryClient.invalidateQueries({ queryKey: billingKeys.all });
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
    (p) => p.tierKey === currentSubscription?.tier_key || p.tierKey === currentSubscription?.tier?.name,
  );

  const userPlanName = currentSubscription?.plan_name || 'none';

  const isSameTier = 
    currentSubscription?.tier_key === tier.tierKey ||
    currentSubscription?.tier?.name === tier.tierKey ||
    currentSubscription?.plan_name === tier.tierKey;
  const isSameBillingPeriod = currentBillingPeriod === billingPeriod;
  

  const isRevenueCatSubscription = currentSubscription?.provider === 'revenuecat';
  
  // More robust current plan detection
  const isCurrentActivePlan = isAuthenticated && isSameTier && 
    (isSameBillingPeriod || isRevenueCatSubscription) &&
    (currentSubscription?.subscription?.status === 'active' || 
     currentSubscription?.status === 'active' ||
     (isRevenueCatSubscription && currentSubscription?.status === 'active') ||
     (currentSubscription?.subscription && !currentSubscription?.subscription?.status));

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
    const isCurrentPlan = isSameTier && isSameBillingPeriod;
    
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
    } else if (isScheduled && currentSubscription?.tier_key === tier.tierKey) {
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
        (currentBillingPeriod === 'monthly' && (billingPeriod === 'yearly' || billingPeriod === 'yearly_commitment')) ||
        (currentBillingPeriod === 'yearly' && billingPeriod === 'yearly_commitment')
      );

      const isYearlyDowngradeToMonthly = false;
      const isSameTierDowngradeToShorterTerm = false;

      if (
        currentAmount === 0 &&
        targetAmount === 0 &&
        currentSubscription?.status !== 'no_subscription'
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
              buttonText = billingPeriod === 'yearly_commitment' ? tCommon('upgrade') : 'Switch to Yearly';
            } else {
              buttonText = 'Switch to Monthly';
            }
            buttonVariant = 'default';
            buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
          } else if (isSameTierUpgradeToLongerTerm && targetAmount <= currentAmount) {
            buttonText = billingPeriod === 'yearly_commitment' ? tCommon('upgrade') : t('switchToLegacyYearly');
            buttonVariant = billingPeriod === 'yearly_commitment' ? tier.buttonColor as ButtonVariant : 'default';
            buttonClassName = billingPeriod === 'yearly_commitment'
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

  return (
    <div
      className={cn(
        'rounded-[18px] flex flex-col relative overflow-hidden',
        insideDialog
          ? 'min-h-[300px]'
          : 'h-full min-h-[300px]',
        tier.isPopular && !insideDialog
          ? 'bg-card border border-border'
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
        <div className="flex items-center justify-between gap-2">
          <TierBadge planName={tier.name} size="lg" variant="default" />
          <div className="flex items-center gap-2">
            {tier.isPopular && (
              <Badge variant='default'>{t('popular')}</Badge>
            )}
            {/* Show upgrade badge for yearly commitment plans when user is on monthly */}
            {isAuthenticated && statusBadge}
          </div>
        </div>
        <div className="flex items-baseline mt-2 min-h-[80px]">
          {billingPeriod === 'yearly_commitment' ? (
            <div className="flex flex-col">
              <div className="flex items-baseline gap-2">
                <PriceDisplay price={displayPrice} isCompact={insideDialog} />
                <span className="text-xs line-through text-muted-foreground">
                  ${tier.price.slice(1)}
                </span>
              </div>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-xs text-muted-foreground">{t('perMonth')}</span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">12mo commit</Badge>
              </div>
            </div>
          ) : billingPeriod === 'yearly' && tier.yearlyPrice && displayPrice !== '$0' ? (
            <div className="flex flex-col">
              <div className="flex items-baseline gap-2">
                <PriceDisplay price={displayPrice} isCompact={insideDialog} />
                {tier.discountPercentage && (
                  <span className="text-xs line-through text-muted-foreground">
                    ${tier.price.slice(1)}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-0.5 mt-1">
                <span className="text-xs text-muted-foreground">{t('perMonth')}</span>
                <span className="text-xs font-medium text-primary">
                  {tier.yearlyPrice} billed annually
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex items-baseline">
                <PriceDisplay price={displayPrice} isCompact={insideDialog} />
              </div>
              <div className="flex items-center gap-1 mt-1">
                {displayPrice !== '$0' && (
                  <span className="text-xs text-muted-foreground">{t('perMonth')}</span>
                )}
              </div>
            </div>
          )}
        </div>
        <p className="hidden text-sm mt-2">{tier.description}</p>
      </div>

      <div className={cn(
        "flex-grow relative z-10",
        insideDialog ? "px-3 pb-2" : "px-4 pb-3"
      )}>
        {tier.features && tier.features.length > 0 && (
          <ul className="space-y-3">
            {tier.features.map((feature) => {
              // Translate feature strings
              let translatedFeature = feature;
              
              // Match and translate common patterns
              if (feature.includes('credits/month')) {
                const match = feature.match(/(\d+[,\d]*)\s*credits\/month/);
                if (match) {
                  const count = match[1].replace(/,/g, '');
                  translatedFeature = t('features.creditsPerMonth', { count });
                }
              } else if (feature.includes('custom Worker') || feature.includes('custom workers')) {
                const match = feature.match(/(\d+)\s*custom\s+(?:Worker|workers)/);
                if (match) {
                  const count = parseInt(match[1]);
                  translatedFeature = count === 1 
                    ? t('features.customWorker', { count })
                    : t('features.customWorkers', { count });
                }
              } else if (feature.includes('private project')) {
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
              } else if (feature.includes('100+ integrations') || feature === '100+ integrations') {
                translatedFeature = t('features.integrations');
              } else if (feature.includes('Premium AI Models') || feature === 'Premium AI Models') {
                translatedFeature = t('features.premiumAIModels');
              } else if (feature.includes('Priority Support') || feature === 'Priority Support') {
                translatedFeature = t('features.prioritySupport');
              }
              
              return (
                <li key={feature} className="flex items-center gap-3">
                  <div className="size-5 min-w-5 flex items-center justify-center text-muted-foreground">
                    {getFeatureIcon(feature)}
                  </div>
                  <span className="text-sm">{translatedFeature}</span>
                </li>
              );
            })}
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

  const { data: subscriptionData, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useSubscription({ enabled: isUserAuthenticated });
  const subCommitmentQuery = useSubscriptionCommitment(subscriptionData?.subscription?.id, isUserAuthenticated);

  const isAuthenticated = isUserAuthenticated && !!subscriptionData && subscriptionQueryError === null;
  const currentSubscription = subscriptionData || null;

  const getCurrentBillingPeriod = (): 'monthly' | 'yearly' | 'yearly_commitment' | null => {
    if (!isAuthenticated || !currentSubscription) {
      console.log(`[BILLING-PERIOD-DEBUG] No auth or subscription: auth=${isAuthenticated}, sub=${!!currentSubscription}`);
      return null;
    }
    
    console.log(`[BILLING-PERIOD-DEBUG] Current subscription billing_period:`, currentSubscription.billing_period);
    console.log(`[BILLING-PERIOD-DEBUG] Current subscription plan_type:`, (currentSubscription as any).plan_type);
    
    // Check API billing_period field first
    if (currentSubscription.billing_period) {
      console.log(`[BILLING-PERIOD-DEBUG] Using API billing_period: ${currentSubscription.billing_period}`);
      return currentSubscription.billing_period;
    }
    
    // Check plan_type field as backup
    if ((currentSubscription as any).plan_type) {
      const planType = (currentSubscription as any).plan_type;
      console.log(`[BILLING-PERIOD-DEBUG] Using API plan_type: ${planType}`);
      return planType;
    }

    if (subCommitmentQuery.data?.has_commitment &&
      subCommitmentQuery.data?.commitment_type === 'yearly_commitment') {
      console.log(`[BILLING-PERIOD-DEBUG] Using commitment query: yearly_commitment`);
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

  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly' | 'yearly_commitment'>(() => {
    const defaultPeriod = getDefaultBillingPeriod();
    console.log(`[BILLING-PERIOD-DEBUG] Initial billing period set to: ${defaultPeriod}`);
    return defaultPeriod;
  });
  const [planLoadingStates, setPlanLoadingStates] = useState<Record<string, boolean>>({});
  const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);
  const [hasUserToggledBillingPeriod, setHasUserToggledBillingPeriod] = useState(false);
  
  useEffect(() => {
    // Only sync to detected billing period on initial load, not when user is actively toggling
    if (currentSubscription && currentBillingPeriod && !hasUserToggledBillingPeriod) {
      console.log(`[BILLING-PERIOD-DEBUG] Initial sync: detected=${currentBillingPeriod}, setting UI to match`);
      setBillingPeriod(currentBillingPeriod);
    }
  }, [currentSubscription, currentBillingPeriod, hasUserToggledBillingPeriod]);

  const handlePlanSelect = (planId: string) => {
    setPlanLoadingStates((prev) => ({ ...prev, [planId]: true }));
  };

  const handleSubscriptionUpdate = () => {
    // Invalidate all billing-related queries to force refetch
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    // Also refetch subscription and commitment directly
    refetchSubscription();
    subCommitmentQuery.refetch();
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

  const isRevenueCatUser = isAuthenticated && currentSubscription?.provider === 'revenuecat';

  return (
    <section
      id="pricing"
      className={cn("flex flex-col items-center justify-center w-full relative", noPadding ? "pb-0" : "pb-12")}
    >
      <div className="w-full mx-auto px-6 flex flex-col items-center">
        {isAlert && (
          <div className="w-full flex justify-center mb-6">
            <h2 className="text-3xl font-medium tracking-tight text-center text-balance leading-tight max-w-2xl text-foreground">
              {alertTitle || t('pickPlan')}
            </h2>
          </div>
        )}
        {showTitleAndTabs && !isAlert && (
          <div className="w-full flex justify-center mb-6">
            <h2 className="text-3xl font-medium tracking-tight text-center text-balance leading-tight max-w-2xl">
              {customTitle || t('pickPlan')}
            </h2>
          </div>
        )}
        <div className="flex justify-center mb-8">
          <BillingPeriodToggle
            billingPeriod={billingPeriod}
            setBillingPeriod={setBillingPeriod}
            setHasUserToggledBillingPeriod={setHasUserToggledBillingPeriod}
          />
        </div>

        <div className={cn(
          "grid gap-4 w-full max-w-6xl",
          insideDialog
            ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
            : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
          !insideDialog && "grid-rows-1 items-stretch"
        )}>
          {siteConfig.cloudPricingItems
            .filter((tier) => !tier.hidden && (!hideFree || tier.price !== '$0'))
            .map((tier) => (
              <PricingTier
                key={tier.name}
                tier={tier}
                currentSubscription={currentSubscription}
                isLoading={planLoadingStates}
                isFetchingPlan={isFetchingPlan}
                onPlanSelect={handlePlanSelect}
                onSubscriptionUpdate={handleSubscriptionUpdate}
                isAuthenticated={isAuthenticated}
                returnUrl={returnUrl}
                insideDialog={insideDialog}
                billingPeriod={billingPeriod}
                currentBillingPeriod={currentBillingPeriod}
              />
            ))}
        </div>

        {/* Get Additional Credits Button - Only visible if tier allows credit purchases */}
        {isAuthenticated &&
          currentSubscription?.credits?.can_purchase_credits && (
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
        {(!isAuthenticated || !currentSubscription?.credits?.can_purchase_credits) && (
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
        currentBalance={currentSubscription?.credits?.balance || 0}
        canPurchase={currentSubscription?.credits?.can_purchase_credits || false}
        onPurchaseComplete={handleSubscriptionUpdate}
      />
    </section>
  );
}

