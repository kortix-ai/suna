'use client';

import { SectionHeader } from '@/components/home/section-header';
import type { PricingTier } from '@/lib/home';
import { siteConfig } from '@/lib/home';
import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import React, { useState, useEffect, useCallback } from 'react';
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
  Zap
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  createCheckoutSession,
  SubscriptionStatus,
  CreateCheckoutSessionResponse,
} from '@/lib/api';
import { toast } from 'sonner';
import { isLocalMode, isYearlyCommitmentDowngrade, isPlanChangeAllowed, getPlanInfo } from '@/lib/config';
import { useSubscription, useSubscriptionCommitment } from '@/hooks/react-query';
import { useAuth } from '@/components/AuthProvider';
import posthog from 'posthog-js';

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
  currentSubscription: SubscriptionStatus | null;
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
      className={isCompact ? 'text-xl font-semibold' : 'text-4xl font-semibold'}
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
  return (
    <div className="flex items-center justify-center gap-3">
      <div className="relative bg-muted rounded-full p-1">
        <div className="flex">
          <div 
            className={cn("px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 cursor-pointer",
              billingPeriod === 'monthly'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setBillingPeriod('monthly')}
          >
            Monthly
          </div>
          <div 
            className={cn("px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 flex items-center gap-1 cursor-pointer",
              billingPeriod === 'yearly_commitment'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setBillingPeriod('yearly_commitment')}
          >
            Yearly
            <span className="bg-green-600 text-green-50 dark:bg-green-500 dark:text-green-50 text-[10px] px-1.5 py-0.5 rounded-full font-semibold whitespace-nowrap">
              15% off
            </span>
          </div>
        </div>
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
}: PricingTierProps) {
  
  // Determine the price to display based on billing period
  const getDisplayPrice = () => {
    if (billingPeriod === 'yearly_commitment' && tier.monthlyCommitmentStripePriceId) {
      // Calculate the yearly commitment price (15% off regular monthly)
      const regularPrice = parseFloat(tier.price.slice(1));
      const discountedPrice = Math.round(regularPrice * 0.85);
      return `$${discountedPrice}`;
    } else if (billingPeriod === 'yearly' && tier.yearlyPrice) {
      // Legacy yearly plans (hidden from UI but still accessible)
      return tier.yearlyPrice;
    }
    return tier.price;
  };

  // Get the price ID to use based on billing period
  const getPriceId = () => {
    if (billingPeriod === 'yearly_commitment' && tier.monthlyCommitmentStripePriceId) {
      return tier.monthlyCommitmentStripePriceId;
    } else if (billingPeriod === 'yearly' && tier.yearlyStripePriceId) {
      // Legacy yearly plans (hidden from UI but still accessible)
      return tier.yearlyStripePriceId;
    }
    return tier.stripePriceId;
  };

  const displayPrice = getDisplayPrice();
  const priceId = getPriceId();

  // Handle subscription/trial start
  const handleSubscribe = async (planStripePriceId: string) => {
    if (!isAuthenticated) {
      window.location.href = '/auth?mode=signup';
      return;
    }

    if (isLoading[planStripePriceId]) {
      return;
    }

    try {
      onPlanSelect?.(planStripePriceId);
      const commitmentType = billingPeriod === 'yearly_commitment' ? 'yearly_commitment' : 
                          billingPeriod === 'yearly' ? 'yearly' : 
                          'monthly';

      const response: CreateCheckoutSessionResponse =
        await createCheckoutSession({
          price_id: planStripePriceId,
          success_url: returnUrl,
          cancel_url: returnUrl,
          commitment_type: commitmentType,
        });

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

  // Find the current tier (moved outside conditional for JSX access)
  const currentTier = siteConfig.cloudPricingItems.find(
    (p) => p.stripePriceId === currentSubscription?.price_id || p.yearlyStripePriceId === currentSubscription?.price_id,
  );

  const userPlanName = currentSubscription?.plan_name || 'none';
  const isCurrentActivePlan = isAuthenticated && (
    currentSubscription?.price_id === priceId ||
    (userPlanName === 'trial' && tier.price === '$20' && billingPeriod === 'monthly') ||
    (userPlanName === 'tier_2_20' && tier.price === '$20' && billingPeriod === 'monthly') ||
    (currentSubscription?.subscription && 
     userPlanName === 'tier_2_20' && 
     tier.price === '$20' && 
     currentSubscription?.subscription?.status === 'active')
  );

  const isScheduled = isAuthenticated && currentSubscription?.has_schedule;
  const isScheduledTargetPlan =
    isScheduled && currentSubscription?.scheduled_price_id === priceId;
  const isPlanLoading = isLoading[priceId];

  let buttonText = isAuthenticated ? 'Select Plan' : tier.buttonText;
  let buttonDisabled = isPlanLoading;
  let buttonVariant: ButtonVariant = null;
  let ringClass = '';
  let statusBadge = null;
  let buttonClassName = '';
  
  const planChangeValidation = (isAuthenticated && currentSubscription?.price_id) 
    ? isPlanChangeAllowed(currentSubscription.price_id, priceId)
    : { allowed: true };

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
    } else if (isScheduled && currentSubscription?.price_id === priceId) {
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
      const currentIsMonthly = currentTier && currentSubscription?.price_id === currentTier.stripePriceId;
      const currentIsYearly = currentTier && currentSubscription?.price_id === currentTier.yearlyStripePriceId;
      const currentIsYearlyCommitment = currentTier && currentSubscription?.price_id === currentTier.monthlyCommitmentStripePriceId;
      const targetIsMonthly = priceId === tier.stripePriceId;
      const targetIsYearly = priceId === tier.yearlyStripePriceId;
      const targetIsYearlyCommitment = priceId === tier.monthlyCommitmentStripePriceId;
      const isSameTierUpgradeToLongerTerm = currentTier && currentTier.name === tier.name &&
        ((currentIsMonthly && (targetIsYearly || targetIsYearlyCommitment)) || 
         (currentIsYearlyCommitment && targetIsYearly));
      
      const isSameTierDowngradeToShorterTerm = currentTier && currentTier.name === tier.name &&
        ((currentIsYearly && targetIsMonthly) || 
         (currentIsYearlyCommitment && targetIsMonthly));

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
      } else if (!planChangeValidation.allowed) {
        // Plan change not allowed due to business rules
        buttonText = 'Not Available';
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground';
      } else {
        if (targetAmount > currentAmount || isSameTierUpgradeToLongerTerm) {
          // Allow upgrade to higher tier OR upgrade to longer term on same tier
          if (currentIsMonthly && targetIsYearlyCommitment && targetAmount <= currentAmount) {
            buttonText = 'Upgrade';
            buttonVariant = tier.buttonColor as ButtonVariant;
            buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
          } else if (currentIsMonthly && targetIsYearly && targetAmount <= currentAmount) {
            buttonText = 'Switch to Legacy Yearly';
            buttonVariant = 'default';
            buttonClassName = 'bg-green-600 hover:bg-green-700 text-white';
          } else if (currentIsYearlyCommitment && targetIsYearly && currentTier?.name === tier.name) {
            buttonText = 'Switch to Legacy Yearly';
            buttonVariant = 'default';
            buttonClassName = 'bg-green-600 hover:bg-green-700 text-white';
          } else {
            buttonText = 'Upgrade';
            buttonVariant = tier.buttonColor as ButtonVariant;
            buttonClassName = 'bg-primary hover:bg-primary/90 text-primary-foreground';
          }
        } else if (targetAmount < currentAmount || isSameTierDowngradeToShorterTerm) {
          // Prevent downgrades and downgrades to shorter terms
          buttonText = 'Not Available';
          buttonDisabled = true;
          buttonVariant = 'secondary';
          buttonClassName = 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground';
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
        ? 'bg-primary hover:bg-primary/90 text-white'
        : 'bg-secondary hover:bg-secondary/90 text-white';
  }

  return (
    <div
      className={cn(
        'rounded-xl flex flex-col relative',
        insideDialog
          ? 'min-h-[300px]'
          : 'h-full min-h-[300px]',
        tier.isPopular && !insideDialog
          ? 'md:shadow-[0px_61px_24px_-10px_rgba(0,0,0,0.01),0px_34px_20px_-8px_rgba(0,0,0,0.05),0px_15px_15px_-6px_rgba(0,0,0,0.09),0px_4px_8px_-2px_rgba(0,0,0,0.10),0px_0px_0px_1px_rgba(0,0,0,0.08)] bg-accent'
          : 'bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] border border-border',
        !insideDialog && ringClass,
      )}
    >
      <div className={cn(
        "flex flex-col gap-3",
        insideDialog ? "p-3" : "p-4"
      )}>
        <p className="text-sm flex items-center gap-2">
          {tier.name}
          {tier.isPopular && (
            <span className="bg-gradient-to-b from-secondary/50 from-[1.92%] to-secondary to-[100%] text-white inline-flex w-fit items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-medium shadow-[0px_6px_6px_-3px_rgba(0,0,0,0.08),0px_3px_3px_-1.5px_rgba(0,0,0,0.08),0px_1px_1px_-0.5px_rgba(0,0,0,0.08),0px_0px_0px_1px_rgba(255,255,255,0.12)_inset,0px_1px_0px_0px_rgba(255,255,255,0.12)_inset]">
              Popular
            </span>
          )}
          {/* Show upgrade badge for yearly commitment plans when user is on monthly */}
          {isAuthenticated && statusBadge}
        </p>
        <div className="flex items-baseline mt-2">
          {billingPeriod === 'yearly_commitment' && tier.monthlyCommitmentStripePriceId ? (
            <div className="flex flex-col">
              <div className="flex items-baseline gap-2">
                <PriceDisplay price={displayPrice} isCompact={insideDialog} />
                <span className="text-xs line-through text-muted-foreground">
                  ${tier.price.slice(1)}
                </span>
              </div>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-xs text-muted-foreground">/month</span>
                <span className="text-xs text-muted-foreground">for one year</span>
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
            <div className="flex items-baseline">
              <PriceDisplay price={displayPrice} isCompact={insideDialog} />
              <span className="ml-2">{displayPrice !== '$0' ? '/month' : ''}</span>
            </div>
          )}
        </div>
        <p className="hidden text-sm mt-2">{tier.description}</p>

        {billingPeriod === 'yearly_commitment' && tier.monthlyCommitmentStripePriceId ? (
          <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-green-50 border-green-200 text-green-700 w-fit">
            Save ${Math.round((parseFloat(tier.price.slice(1)) - parseFloat(displayPrice.slice(1))) * 12)} per year
          </div>
        ) : billingPeriod === 'yearly' && tier.yearlyPrice && tier.discountPercentage ? (
          <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-green-50 border-green-200 text-green-700 w-fit">
            Save ${Math.round(parseFloat(tier.originalYearlyPrice?.slice(1) || '0') - parseFloat(tier.yearlyPrice.slice(1)))} per year
          </div>
        ) : (
          <div className="hidden items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-primary/10 border-primary/20 text-primary w-fit">
            {billingPeriod === 'yearly' && tier.yearlyPrice && displayPrice !== '$0'
              ? `$${Math.round(parseFloat(tier.yearlyPrice.slice(1)) / 12)}/month (billed yearly)`
              : `${displayPrice}/month`
            }
          </div>
        )}
      </div>

      <div className={cn(
        "flex-grow",
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
        "mt-auto",
        insideDialog ? "px-3 pt-1 pb-3" : "px-4 pt-2 pb-4"
      )}>
        <Button
          onClick={() => handleSubscribe(priceId)}
          disabled={buttonDisabled}
          variant={buttonVariant || 'default'}
          className={cn(
            'w-full font-medium transition-all duration-200',
            isCompact || insideDialog ? 'h-8 text-xs' : 'h-10 rounded-full text-sm',
            buttonClassName,
            isPlanLoading && 'animate-pulse',
          )}
          title={!planChangeValidation.allowed ? planChangeValidation.reason : undefined}
        >
          {buttonText}
        </Button>
      </div>
    </div>
  );
}

interface PricingSectionProps {
  returnUrl?: string;
  showTitleAndTabs?: boolean;
  hideFree?: boolean;
  insideDialog?: boolean;
  showInfo?: boolean;
  noPadding?: boolean;
  onSubscriptionUpdate?: () => void;
}

export function PricingSection({
  returnUrl = typeof window !== 'undefined' ? window.location.href : '/',
  showTitleAndTabs = true,
  hideFree = false,
  insideDialog = false,
  showInfo = true,
  noPadding = false,
  onSubscriptionUpdate,
}: PricingSectionProps) {
  const { user } = useAuth();
  const isUserAuthenticated = !!user;

  const { data: subscriptionData, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useSubscription({ enabled: isUserAuthenticated });
  const subCommitmentQuery = useSubscriptionCommitment(subscriptionData?.subscription_id, isUserAuthenticated);

  const isAuthenticated = isUserAuthenticated && !!subscriptionData && subscriptionQueryError === null;
  const currentSubscription = subscriptionData || null;

  const getDefaultBillingPeriod = useCallback((): 'monthly' | 'yearly' | 'yearly_commitment' => {
    if (!isAuthenticated || !currentSubscription) {
      return 'yearly_commitment';
    }

    const currentTier = siteConfig.cloudPricingItems.find(
      (p) => p.stripePriceId === currentSubscription.price_id || 
             p.yearlyStripePriceId === currentSubscription.price_id ||
             p.monthlyCommitmentStripePriceId === currentSubscription.price_id,
    );

    if (currentTier) {
      if (currentTier.monthlyCommitmentStripePriceId === currentSubscription.price_id) {
        return 'yearly_commitment';
      } else if (currentTier.yearlyStripePriceId === currentSubscription.price_id) {
        return 'yearly';
      } else if (currentTier.stripePriceId === currentSubscription.price_id) {
        return 'monthly';
      }
    }

    return 'yearly_commitment';
  }, [isAuthenticated, currentSubscription]);

  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly' | 'yearly_commitment'>(getDefaultBillingPeriod());
  const [planLoadingStates, setPlanLoadingStates] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setBillingPeriod(getDefaultBillingPeriod());
  }, [getDefaultBillingPeriod]);

  const handlePlanSelect = (planId: string) => {
    setPlanLoadingStates((prev) => ({ ...prev, [planId]: true }));
  };

  const handleSubscriptionUpdate = () => {
    refetchSubscription();
    subCommitmentQuery.refetch();
    // The useSubscription hook will automatically refetch, so we just need to clear loading states
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
      className={cn("flex flex-col items-center justify-center gap-10 w-full relative", noPadding ? "pb-0" : "pb-12")}
    >
      <div className="w-full max-w-6xl mx-auto px-6">
        {showTitleAndTabs && (
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
              Choose the right plan for your needs
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Start with our free plan or upgrade for more AI token credits
            </p>
          </SectionHeader>
        )}

        <div className="flex justify-center mb-8">
          <BillingPeriodToggle
            billingPeriod={billingPeriod}
            setBillingPeriod={setBillingPeriod}
          />
        </div>

        <div className={cn(
          "grid gap-6 w-full",
          insideDialog
            ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 2xl:grid-cols-3"
            : "min-[650px]:grid-cols-2 lg:grid-cols-3",
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
              />
            ))}
        </div>
      </div>
      {showInfo && (
        <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg max-w-2xl mx-auto">
          <p className="text-sm text-blue-800 dark:text-blue-200 text-center">
            <strong>What are AI tokens?</strong> Tokens are units of text that AI models process. 
            Your plan includes credits to spend on various AI models - the more complex the task, 
            the more tokens used.
          </p>
        </div>
      )}
    </section>
  );
}

