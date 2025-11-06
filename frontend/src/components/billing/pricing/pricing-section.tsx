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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SubscriptionInfo } from '@/lib/api/billing-v2';
import { createCheckoutSession, CreateCheckoutSessionRequest, CreateCheckoutSessionResponse } from '@/lib/api';
import { toast } from 'sonner';
import { isLocalMode } from '@/lib/config';
import { useSubscription } from '@/hooks/use-billing-v2';
import { useSubscriptionCommitment } from '@/hooks/subscriptions/use-subscriptions';
import { useAuth } from '@/components/AuthProvider';
import posthog from 'posthog-js';
import { Badge } from '@/components/ui/badge';
import { AnimatedBg } from '@/components/home/ui/AnimatedBg';
import { TierBadge } from '@/components/billing/tier-badge';
import { getPlanIcon } from '@/components/billing/plan-utils';

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
}: PricingTierProps) {

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

  // Handle subscription/trial start
  const handleSubscribe = async (tierKey: string) => {
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

  // Find the current tier using tier_key
  const currentTier = siteConfig.cloudPricingItems.find(
    (p) => p.tierKey === currentSubscription?.tier_key || p.tierKey === currentSubscription?.tier?.name,
  );

  const userPlanName = currentSubscription?.plan_name || 'none';
  const isCurrentActivePlan = isAuthenticated && (
    currentSubscription?.tier_key === tier.tierKey ||
    currentSubscription?.tier?.name === tier.tierKey ||
    (userPlanName === 'trial' && tier.price === '$20' && billingPeriod === 'monthly') ||
    (userPlanName === 'tier_2_20' && tier.price === '$20' && billingPeriod === 'monthly') ||
    (currentSubscription?.subscription &&
      userPlanName === 'tier_2_20' &&
      tier.price === '$20' &&
      currentSubscription?.subscription?.status === 'active')
  );

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
        <div className="flex items-center gap-2">
          {tier.name === 'Basic' ? (
            // For Basic plan, just show plain text
            <span className="text-lg font-semibold">Basic</span>
          ) : (
            <TierBadge planName={tier.name} size="lg" variant="default" />
          )}
          <div className="flex items-center gap-2">
            {tier.isPopular && (
              <Badge variant='outline'>Popular</Badge>
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
          onClick={() => handleSubscribe(tier.tierKey)}
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
}

export function PricingSection({
  returnUrl = typeof window !== 'undefined' ? window.location.href : '/',
  showTitleAndTabs = true,
  hideFree = false,
  insideDialog = false,
  noPadding = false,
  onSubscriptionUpdate,
}: PricingSectionProps) {
  const { user } = useAuth();
  const isUserAuthenticated = !!user;

  const { data: subscriptionData, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useSubscription(isUserAuthenticated);
  const subCommitmentQuery = useSubscriptionCommitment(subscriptionData?.subscription?.id, isUserAuthenticated);

  const isAuthenticated = isUserAuthenticated && !!subscriptionData && subscriptionQueryError === null;
  const currentSubscription = subscriptionData || null;

  const getDefaultBillingPeriod = useCallback((): 'monthly' | 'yearly' | 'yearly_commitment' => {
    if (!isAuthenticated || !currentSubscription) {
      return 'yearly_commitment';
    }

    // Default to yearly_commitment for now
    // Backend will resolve tier_key to the appropriate Stripe price_id internally based on commitment_type
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
      className={cn("flex flex-col items-center justify-center w-full relative", noPadding ? "pb-0" : "pb-12")}
    >
      <div className="w-full mx-auto px-6 flex flex-col items-center">
        {showTitleAndTabs && (
          <div className="w-full flex justify-center mb-6">
            <h2 className="text-3xl md:text-4xl font-medium tracking-tight text-center text-balance leading-tight max-w-2xl">
              Pick the plan that works for you.
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
              />
            ))}
        </div>
      </div>
    </section>
  );
}

