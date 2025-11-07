'use client';

import type { PricingTier } from '@/lib/home';
import { siteConfig } from '@/lib/home';
import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
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
  if (featureLower.includes('custom agents') || featureLower.includes('agents')) {
    return <Bot className="size-4" />;
  }
  if (featureLower.includes('private projects') || featureLower.includes('public projects')) {
    return <FileText className="size-4" />;
  }
  if (featureLower.includes('custom abilities') || featureLower.includes('basic abilities')) {
    return <Settings className="size-4" />;
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
  setBillingPeriod
}: {
  billingPeriod: 'monthly' | 'yearly' | 'yearly_commitment';
  setBillingPeriod: (period: 'monthly' | 'yearly' | 'yearly_commitment') => void;
}) {
  const isYearly = billingPeriod === 'yearly_commitment' || billingPeriod === 'yearly';

  return (
    <div className="flex items-center justify-center w-full">
      <div className="flex gap-2 items-center">
        <Button
          variant={billingPeriod === 'monthly' ? 'default' : 'outline'}
          onClick={() => setBillingPeriod('monthly')}
          className={cn(
            "border-[1.5px]",
            billingPeriod === 'monthly' ? 'border-primary' : 'border-border'
          )}
        >
          Monthly
        </Button>
        <Button
          variant={billingPeriod === 'yearly_commitment' ? 'default' : 'outline'}
          onClick={() => setBillingPeriod('yearly_commitment')}
          className={cn(
            "flex items-center gap-1.5 border-[1.5px]",
            billingPeriod === 'yearly_commitment' ? 'border-primary' : 'border-border'
          )}
        >
          Yearly
          <span className={cn(
            "px-1.5 py-0.5 rounded-full text-xs font-medium",
            isYearly
              ? "bg-background/90 text-primary"
              : "bg-muted/80 text-primary dark:bg-muted"
          )}>
            15% off
          </span>
        </Button>
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
  const queryClient = useQueryClient();

  // Determine the price to display based on billing period
  const getDisplayPrice = () => {
    // For $0 plans, always show $0
    if (tier.price === '$0') {
      return '$0';
    }

    if (billingPeriod === 'yearly_commitment') {
      // Calculate the yearly commitment price (15% off regular monthly)
      const regularPrice = parseFloat(tier.price.slice(1));
      const discountedPrice = Math.round(regularPrice * 0.85);
      console.log(`[${tier.name}] Yearly Commitment: $${regularPrice} -> $${discountedPrice}`);
      return `$${discountedPrice}`;
    } else if (billingPeriod === 'yearly' && tier.yearlyPrice) {
      console.log(`[${tier.name}] Yearly: ${tier.yearlyPrice}`);
      return tier.yearlyPrice;
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
          success_url: returnUrl,
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
            toast.error('Failed to initiate subscription. Please try again.');
          }
          break;
        case 'upgraded':
        case 'updated':
          const upgradeMessage = response.details?.is_upgrade
            ? `Subscription upgraded from $${response.details.current_price} to $${response.details.new_price}`
            : 'Subscription updated successfully';
          toast.success(upgradeMessage);
          posthog.capture('plan_upgraded');
          // Invalidate all billing queries immediately after upgrade
          queryClient.invalidateQueries({ queryKey: billingKeys.all });
          // Trigger subscription update callback to refetch data
          if (onSubscriptionUpdate) onSubscriptionUpdate();
          break;
        case 'commitment_blocks_downgrade':
          toast.warning(response.message || 'Cannot downgrade during commitment period');
          break;
        case 'downgrade_scheduled':
        case 'scheduled':
          const effectiveDate = response.effective_date
            ? new Date(response.effective_date).toLocaleDateString()
            : 'the end of your billing period';

          const statusChangeMessage = 'Subscription change scheduled';

          toast.success(
            <div>
              <p>{statusChangeMessage}</p>
              <p className="text-sm mt-1">
                Your plan will change on {effectiveDate}.
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
          toast.info(response.message || 'You are already on this plan.');
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

  // Find the current tier using tier_key
  const currentTier = siteConfig.cloudPricingItems.find(
    (p) => p.tierKey === currentSubscription?.tier_key || p.tierKey === currentSubscription?.tier?.name,
  );

  const userPlanName = currentSubscription?.plan_name || 'none';

  // Check if this is the current plan - must match BOTH tier_key AND billing period
  const isSameTier = currentSubscription?.tier_key === tier.tierKey ||
    currentSubscription?.tier?.name === tier.tierKey;
  const isSameBillingPeriod = currentBillingPeriod === billingPeriod;

  const isCurrentActivePlan = isAuthenticated && isSameTier && isSameBillingPeriod &&
    currentSubscription?.subscription?.status === 'active';

  const isScheduled = isAuthenticated && (currentSubscription as any)?.has_schedule;
  const isScheduledTargetPlan =
    isScheduled && (
      (currentSubscription as any)?.scheduled_tier_key === tier.tierKey ||
      (currentSubscription as any)?.scheduled_plan_name === tier.tierKey ||
      (currentSubscription as any)?.scheduled_plan_name === tier.name
    );
  const isPlanLoading = isLoading[tier.tierKey];

  let buttonText = isAuthenticated ? 'Select Plan' : tier.buttonText;
  let buttonDisabled = isPlanLoading;
  let buttonVariant: ButtonVariant = null;
  let ringClass = '';
  let statusBadge = null;
  let buttonClassName = '';
  let isDowngradeAction = false;

  const planChangeValidation = { allowed: true };

  if (isAuthenticated) {
    if (isCurrentActivePlan) {
      if (userPlanName === 'trial') {
        buttonText = 'Trial Active';
        statusBadge = (
          <span className="bg-green-500/10 text-green-600 text-[10px] font-medium px-1.5 py-0.5 rounded-full">
            7-Day Trial
          </span>
        );
      } else {
        buttonText = 'Current Plan';
        statusBadge = (
          <span className="bg-primary/10 text-primary text-[10px] font-medium px-1.5 py-0.5 rounded-full">
            Current
          </span>
        );
      }
      buttonDisabled = true;
      buttonVariant = 'secondary';
      ringClass = isCompact ? 'ring-1 ring-primary' : 'ring-2 ring-primary';
      buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
    } else if (isScheduledTargetPlan) {
      buttonText = 'Scheduled';
      buttonDisabled = true;
      buttonVariant = 'outline';
      ringClass = isCompact
        ? 'ring-1 ring-yellow-500'
        : 'ring-2 ring-yellow-500';
      buttonClassName =
        'bg-yellow-500/5 hover:bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      statusBadge = (
        <span className="bg-yellow-500/10 text-yellow-600 text-[10px] font-medium px-1.5 py-0.5 rounded-full">
          Scheduled
        </span>
      );
    } else if (isScheduled && currentSubscription?.tier_key === tier.tierKey) {
      buttonText = 'Change Scheduled';
      buttonVariant = 'secondary';
      ringClass = isCompact ? 'ring-1 ring-primary' : 'ring-2 ring-primary';
      buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
      statusBadge = (
        <span className="bg-yellow-500/10 text-yellow-600 text-[10px] font-medium px-1.5 py-0.5 rounded-full">
          Downgrade Pending
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

      // Check if current subscription is monthly and target is yearly commitment for same tier
      const isSameTier = currentTier && currentTier.tierKey === tier.tierKey;
      const isSameTierUpgradeToLongerTerm = isSameTier && (
        (billingPeriod === 'yearly_commitment' || billingPeriod === 'yearly')
      );

      // Prevent downgrading from yearly to monthly - once yearly, stay yearly
      // This blocks: yearly -> monthly, yearly_commitment -> monthly for same tier
      const isYearlyDowngradeToMonthly = isSameTier &&
        currentBillingPeriod &&
        (currentBillingPeriod === 'yearly' || currentBillingPeriod === 'yearly_commitment') &&
        billingPeriod === 'monthly' &&
        currentSubscription?.subscription?.status === 'active';

      const isSameTierDowngradeToShorterTerm = false; // Simplified for now

      // Use the plan change validation already computed above

      if (
        currentAmount === 0 &&
        targetAmount === 0 &&
        currentSubscription?.status !== 'no_subscription'
      ) {
        buttonText = 'Select Plan';
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
      } else if (isYearlyDowngradeToMonthly) {
        // Prevent downgrading from yearly to monthly - once yearly, stay yearly
        buttonText = 'Not Available';
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground';
      } else if (!planChangeValidation.allowed) {
        // Plan change not allowed due to business rules
        buttonText = 'Not Available';
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground';
      } else {
        if (targetAmount > currentAmount || isSameTierUpgradeToLongerTerm) {
          // Allow upgrade to higher tier OR upgrade to longer term on same tier
          if (isSameTierUpgradeToLongerTerm && targetAmount <= currentAmount) {
            buttonText = billingPeriod === 'yearly_commitment' ? 'Upgrade' : 'Switch to Legacy Yearly';
            buttonVariant = billingPeriod === 'yearly_commitment' ? tier.buttonColor as ButtonVariant : 'default';
            buttonClassName = billingPeriod === 'yearly_commitment'
              ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
              : 'bg-green-600 hover:bg-green-700 text-white';
          } else {
            buttonText = 'Upgrade';
            buttonVariant = tier.buttonColor as ButtonVariant;
            buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
          }
        } else if (targetAmount < currentAmount || isSameTierDowngradeToShorterTerm) {
          buttonText = 'Downgrade';
          buttonVariant = 'outline';
          buttonClassName = '';
          isDowngradeAction = true;
        } else {
          buttonText = 'Select Plan';
          buttonVariant = tier.buttonColor as ButtonVariant;
          buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
        }
      }
    }

    if (isPlanLoading) {
      buttonText = 'Loading...';
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
              <Badge variant='default'>Popular</Badge>
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
                <span className="text-xs text-muted-foreground">/month</span>
              </div>
            </div>
          ) : billingPeriod === 'yearly' && tier.yearlyPrice && displayPrice !== '$0' ? (
            <div className="flex flex-col">
              <div className="flex items-baseline gap-2">
                <PriceDisplay price={`$${Math.round(parseFloat(tier.yearlyPrice.slice(1)) / 12)}`} isCompact={insideDialog} />
                {tier.discountPercentage && (
                  <span className="text-xs line-through text-muted-foreground">
                    ${Math.round(parseFloat(tier.originalYearlyPrice?.slice(1) || '0') / 12)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-muted-foreground">/month</span>
                <span className="text-xs text-muted-foreground">billed yearly</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex items-baseline">
                <PriceDisplay price={displayPrice} isCompact={insideDialog} />
              </div>
              <div className="flex items-center gap-1 mt-1">
                {displayPrice !== '$0' && (
                  <span className="text-xs text-muted-foreground">/month</span>
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
            {tier.features.map((feature) => (
              <li key={feature} className="flex items-center gap-3">
                <div className="size-5 min-w-5 flex items-center justify-center text-muted-foreground">
                  {getFeatureIcon(feature)}
                </div>
                <span className="text-sm">{feature}</span>
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
}

export function PricingSection({
  returnUrl = typeof window !== 'undefined' ? window.location.href : '/',
  showTitleAndTabs = true,
  hideFree = false,
  insideDialog = false,
  noPadding = false,
  onSubscriptionUpdate,
  customTitle,
}: PricingSectionProps) {
  const { user } = useAuth();
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();

  const { data: subscriptionData, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useSubscription({ enabled: isUserAuthenticated });
  const subCommitmentQuery = useSubscriptionCommitment(subscriptionData?.subscription?.id, isUserAuthenticated);

  const isAuthenticated = isUserAuthenticated && !!subscriptionData && subscriptionQueryError === null;
  const currentSubscription = subscriptionData || null;

  // Determine current subscription's billing period
  const getCurrentBillingPeriod = (): 'monthly' | 'yearly' | 'yearly_commitment' | null => {
    if (!isAuthenticated || !currentSubscription) {
      return null;
    }

    // Use billing_period from API response (most reliable - comes from price_id)
    if (currentSubscription.billing_period) {
      return currentSubscription.billing_period;
    }

    // Fallback: Check commitment info
    if (subCommitmentQuery.data?.has_commitment &&
      subCommitmentQuery.data?.commitment_type === 'yearly_commitment') {
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

    // Default to monthly if period is short or can't determine
    return 'monthly';
  };

  const currentBillingPeriod = getCurrentBillingPeriod();

  const getDefaultBillingPeriod = useCallback((): 'monthly' | 'yearly' | 'yearly_commitment' => {
    if (!isAuthenticated || !currentSubscription) {
      return 'yearly_commitment';
    }

    // Use current subscription's billing period if available, otherwise default to yearly_commitment
    return currentBillingPeriod || 'yearly_commitment';
  }, [isAuthenticated, currentSubscription, currentBillingPeriod]);

  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly' | 'yearly_commitment'>(getDefaultBillingPeriod());
  const [planLoadingStates, setPlanLoadingStates] = useState<Record<string, boolean>>({});
  const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);

  useEffect(() => {
    setBillingPeriod(getDefaultBillingPeriod());
  }, [getDefaultBillingPeriod]);

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
          Running in local development mode - billing features are disabled
        </p>
      </div>
    );
  }

  return (
    <section
      id="pricing"
      className={cn("flex flex-col items-center justify-center w-full relative", noPadding ? "pb-0" : "pb-12")}
    >
      <div className="w-full mx-auto px-6 flex flex-col items-center">
        {showTitleAndTabs && (
          <div className="w-full flex justify-center mb-6">
            <h2 className="text-3xl md:text-4xl font-medium tracking-tight text-center text-balance leading-tight max-w-2xl">
              {customTitle || 'Pick the plan that works for you.'}
            </h2>
          </div>
        )}

        <div className="flex justify-center mb-8">
          <BillingPeriodToggle
            billingPeriod={billingPeriod}
            setBillingPeriod={setBillingPeriod}
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
                Get Additional Credits
              </Button>
              {/* Credits Explained Link */}
              <Button
                variant="link"
                onClick={() => window.open('/credits-explained', '_blank')}
                className="text-muted-foreground hover:text-foreground h-auto p-0"
              >
                <Lightbulb className="h-3.5 w-3.5 mr-2" />
                <span className="text-sm">Credits explained</span>
              </Button>
            </div>
          )}

        {/* Credits Explained Link - Show when not authenticated or when credits purchase is not available */}
        {(!isAuthenticated || !currentSubscription?.credits?.can_purchase_credits) && (
          <div className="w-full max-w-6xl mt-8 flex justify-center">
            <Button
              variant="link"
              onClick={() => window.open('/credits-explained', '_blank')}
              className="text-muted-foreground hover:text-foreground h-auto p-0"
            >
              <Lightbulb className="h-3.5 w-3.5 mr-2" />
              <span className="text-sm">Credits explained</span>
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

