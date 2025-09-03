'use client';

import { SectionHeader } from '@/components/home/section-header';
import type { PricingTier } from '@/lib/home';
import { siteConfig } from '@/lib/home';
import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import { useState, useEffect, useRef } from 'react';
import { CheckIcon } from 'lucide-react';
import Link from 'next/link';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  getSubscription,
  createCheckoutSession,
  SubscriptionStatus,
  CreateCheckoutSessionResponse,
} from '@/lib/api';
import { toast } from 'sonner';
import { isLocalMode } from '@/lib/config';

// Constants
const DEFAULT_SELECTED_PLAN = '6 hours';
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

interface PricingTabsProps {
  activeTab: 'cloud' | 'self-hosted';
  setActiveTab: (tab: 'cloud' | 'self-hosted') => void;
  className?: string;
}

interface PriceDisplayProps {
  price: string;
  isCompact?: boolean;
}

interface CustomPriceDisplayProps {
  price: string;
}

interface UpgradePlan {
  hours: string;
  price: string;
  stripePriceId: string;
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
}

// Components
function PricingTabs({ activeTab, setActiveTab, className }: PricingTabsProps) {
  return (
    <div
      className={cn(
        'relative flex w-fit items-center rounded-full border p-0.5 backdrop-blur-sm cursor-pointer h-9 flex-row bg-muted',
        className,
      )}
    >
      {['cloud', 'self-hosted'].map((tab) => (
        <button
          key={tab}
          onClick={() => setActiveTab(tab as 'cloud' | 'self-hosted')}
          className={cn(
            'relative z-[1] px-3 h-8 flex items-center justify-center cursor-pointer',
            {
              'z-0': activeTab === tab,
            },
          )}
        >
          {activeTab === tab && (
            <motion.div
              layoutId="active-tab"
              className="absolute inset-0 rounded-full bg-white dark:bg-[#3F3F46] shadow-md border border-border"
              transition={{
                duration: 0.2,
                type: 'spring',
                stiffness: 300,
                damping: 25,
                velocity: 2,
              }}
            />
          )}
          <span
            className={cn(
              'relative block text-sm font-medium duration-200 shrink-0',
              activeTab === tab ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            {tab === 'cloud' ? 'Cloud' : 'Enterprise'}
          </span>
        </button>
      ))}
    </div>
  );
}

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

function CustomPriceDisplay({ price }: CustomPriceDisplayProps) {
  return (
    <motion.span
      key={price}
      className="text-4xl font-semibold"
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
}: PricingTierProps) {
  const [localSelectedPlan, setLocalSelectedPlan] = useState(
    selectedPlan || DEFAULT_SELECTED_PLAN,
  );
  const hasInitialized = useRef(false);

  // Auto-select the correct plan only on initial load
  useEffect(() => {
    if (
      !hasInitialized.current &&
      tier.name === 'Custom' &&
      tier.upgradePlans &&
      currentSubscription?.price_id
    ) {
      const matchingPlan = tier.upgradePlans.find(
        (plan) => plan.stripePriceId === currentSubscription.price_id,
      );
      if (matchingPlan) {
        setLocalSelectedPlan(matchingPlan.hours);
      }
      hasInitialized.current = true;
    }
  }, [currentSubscription, tier.name, tier.upgradePlans]);

  // Only refetch when plan is selected
  const handlePlanSelect = (value: string) => {
    setLocalSelectedPlan(value);
    if (tier.name === 'Custom' && onSubscriptionUpdate) {
      onSubscriptionUpdate();
    }
  };

  const handleSubscribe = async (planStripePriceId: string) => {
    if (!isAuthenticated) {
      window.location.href = '/auth';
      return;
    }

    if (isLoading[planStripePriceId]) {
      return;
    }

    try {
      // For custom tier, get the selected plan's stripePriceId
      let finalPriceId = planStripePriceId;
      if (tier.name === 'Custom' && tier.upgradePlans) {
        const selectedPlan = tier.upgradePlans.find(
          (plan) => plan.hours === localSelectedPlan,
        );
        if (selectedPlan?.stripePriceId) {
          finalPriceId = selectedPlan.stripePriceId;
        }
      }

      onPlanSelect?.(finalPriceId);

      const response: CreateCheckoutSessionResponse =
        await createCheckoutSession({
          price_id: finalPriceId,
          success_url: returnUrl,
          cancel_url: returnUrl,
        });

      console.log('Subscription action response:', response);

      switch (response.status) {
        case 'new':
        case 'checkout_created':
          if (response.url) {
            window.location.href = response.url;
          } else {
            console.error(
              "Error: Received status 'checkout_created' but no checkout URL.",
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
          if (onSubscriptionUpdate) onSubscriptionUpdate();
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

  const getPriceValue = (
    tier: PricingTier,
    selectedHours?: string,
  ): string => {
    if (tier.upgradePlans && selectedHours) {
      const plan = tier.upgradePlans.find(
        (plan) => plan.hours === selectedHours,
      );
      if (plan) {
        return plan.price;
      }
    }
    return tier.price;
  };

  const getDisplayedHours = (
    tier: PricingTier,
  ) => {
    if (tier.name === 'Custom' && localSelectedPlan) {
      return localSelectedPlan;
    }
    return tier.hours;
  };

  const getSelectedPlanPriceId = (
    tier: PricingTier,
  ): string => {
    if (tier.name === 'Custom' && tier.upgradePlans) {
      const selectedPlan = tier.upgradePlans.find(
        (plan) => plan.hours === localSelectedPlan,
      );
      return selectedPlan?.stripePriceId || tier.stripePriceId;
    }
    return tier.stripePriceId;
  };

  const getSelectedPlanPrice = (
    tier: PricingTier,
  ): string => {
    if (tier.name === 'Custom' && tier.upgradePlans) {
      const selectedPlan = tier.upgradePlans.find(
        (plan) => plan.hours === localSelectedPlan,
      );
      return selectedPlan?.price || tier.price;
    }
    return tier.price;
  };

  const tierPriceId = getSelectedPlanPriceId(tier);
  const isCurrentActivePlan =
    isAuthenticated &&
    // For custom tier, check if the selected plan matches the current subscription
    (tier.name === 'Custom'
      ? tier.upgradePlans?.some(
          (plan) =>
            plan.hours === localSelectedPlan &&
            plan.stripePriceId === currentSubscription?.price_id,
        )
      : currentSubscription?.price_id === tierPriceId);
  const isScheduled = isAuthenticated && currentSubscription?.has_schedule;
  const isScheduledTargetPlan =
    isScheduled &&
    // For custom tier, check if the selected plan matches the scheduled subscription
    (tier.name === 'Custom'
      ? tier.upgradePlans?.some(
          (plan) =>
            plan.hours === localSelectedPlan &&
            plan.stripePriceId === currentSubscription?.scheduled_price_id,
        )
      : currentSubscription?.scheduled_price_id === tierPriceId);
  const isPlanLoading = isLoading[tierPriceId];

  let buttonText = isAuthenticated ? 'Select Plan' : 'Try Free';
  let buttonDisabled = isPlanLoading;
  let buttonVariant: ButtonVariant = null;
  let ringClass = '';
  let statusBadge = null;
  let buttonClassName = '';

  if (isAuthenticated) {
    if (isCurrentActivePlan) {
      buttonText = 'Current Plan';
      buttonDisabled = true;
      buttonVariant = 'secondary';
      ringClass = isCompact ? 'ring-1 ring-primary' : 'ring-2 ring-primary';
      buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
      statusBadge = (
        <span className="bg-primary/10 text-primary text-[10px] font-medium px-1.5 py-0.5 rounded-full">
          Current
        </span>
      );
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
    } else if (isScheduled && currentSubscription?.price_id === tierPriceId) {
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
      // For custom tier, find the current plan in upgradePlans
      const currentTier =
        tier.name === 'Custom' && tier.upgradePlans
          ? tier.upgradePlans.find(
              (p) => p.stripePriceId === currentSubscription?.price_id,
            )
          : siteConfig.cloudPricingItems.find(
              (p) => p.stripePriceId === currentSubscription?.price_id,
            );

      // Find the highest active plan from upgradePlans
      const highestActivePlan = siteConfig.cloudPricingItems.reduce(
        (highest, item) => {
          if (item.upgradePlans) {
            const activePlan = item.upgradePlans.find(
              (p) => p.stripePriceId === currentSubscription?.price_id,
            );
            if (activePlan) {
              const activeAmount =
                parseFloat(activePlan.price.replace(/[^\d.]/g, '') || '0') *
                100;
              const highestAmount =
                parseFloat(highest?.price?.replace(/[^\d.]/g, '') || '0') * 100;
              return activeAmount > highestAmount ? activePlan : highest;
            }
          }
          return highest;
        },
        null as { price: string; hours: string; stripePriceId: string } | null,
      );

      const currentPriceString = currentSubscription
        ? highestActivePlan?.price || currentTier?.price || '$0'
        : '$0';
      const selectedPriceString = getSelectedPlanPrice(tier);
      const currentAmount =
        currentPriceString === '$0'
          ? 0
          : parseFloat(currentPriceString.replace(/[^\d.]/g, '') || '0') * 100;
      const targetAmount =
        selectedPriceString === '$0'
          ? 0
          : parseFloat(selectedPriceString.replace(/[^\d.]/g, '') || '0') * 100;

      if (
        currentAmount === 0 &&
        targetAmount === 0 &&
        currentSubscription?.status !== 'no_subscription'
      ) {
        buttonText = 'Select Plan';
        buttonDisabled = true;
        buttonVariant = 'secondary';
        buttonClassName = 'bg-primary/5 hover:bg-primary/10 text-primary';
      } else {
        if (targetAmount > currentAmount) {
          buttonText = 'Upgrade';
          buttonVariant = tier.buttonColor as ButtonVariant;
          buttonClassName =
            'bg-primary hover:bg-primary/90 text-primary-foreground';
        } else if (targetAmount < currentAmount) {
          buttonText = '-';
          buttonDisabled = true;
          buttonVariant = 'secondary';
          buttonClassName =
            'opacity-50 cursor-not-allowed bg-muted text-muted-foreground';
        } else {
          buttonText = 'Select Plan';
          buttonVariant = tier.buttonColor as ButtonVariant;
          buttonClassName =
            'bg-primary hover:bg-primary/90 text-primary-foreground';
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
        'rounded-xl flex flex-col relative h-fit min-h-[400px] min-[650px]:h-full min-[900px]:h-fit',
        tier.isPopular && !insideDialog
          ? 'md:shadow-[0px_61px_24px_-10px_rgba(0,0,0,0.01),0px_34px_20px_-8px_rgba(0,0,0,0.05),0px_15px_15px_-6px_rgba(0,0,0,0.09),0px_4px_8px_-2px_rgba(0,0,0,0.10),0px_0px_0px_1px_rgba(0,0,0,0.08)] bg-accent'
          : 'bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] border border-border',
        !insideDialog && ringClass,
      )}
    >
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm flex items-center gap-2">
          {tier.name}
          {tier.isPopular && (
            <span className="bg-gradient-to-b from-secondary/50 from-[1.92%] to-secondary to-[100%] text-white h-6 inline-flex w-fit items-center justify-center px-2 rounded-full text-sm shadow-[0px_6px_6px_-3px_rgba(0,0,0,0.08),0px_3px_3px_-1.5px_rgba(0,0,0,0.08),0px_1px_1px_-0.5px_rgba(0,0,0,0.08),0px_0px_0px_1px_rgba(255,255,255,0.12)_inset,0px_1px_0px_0px_rgba(255,255,255,0.12)_inset]">
              Popular
            </span>
          )}
          {isAuthenticated && statusBadge}
        </p>
        <div className="flex items-baseline mt-2">
          {tier.name === 'Custom' ? (
            <CustomPriceDisplay
              price={getPriceValue(tier, localSelectedPlan)}
            />
          ) : (
            <PriceDisplay price={tier.price} />
          )}
          <span className="ml-2">{tier.price !== '$0' ? '/month' : ''}</span>
        </div>
        <p className="text-sm mt-2">{tier.description}</p>

        {tier.name === 'Custom' && tier.upgradePlans ? (
          <div className="w-full space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Customize your monthly usage
            </p>
            <Select value={localSelectedPlan} onValueChange={handlePlanSelect}>
              <SelectTrigger className="w-full bg-white dark:bg-background">
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                {tier.upgradePlans.map((plan) => (
                  <SelectItem
                    key={plan.hours}
                    value={plan.hours}
                    className={
                      localSelectedPlan === plan.hours
                        ? 'font-medium bg-primary/5'
                        : ''
                    }
                  >
                    {plan.hours} - {plan.price}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-primary/10 border-primary/20 text-primary w-fit">
              {localSelectedPlan}/month
            </div>
          </div>
        ) : (
          <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold bg-primary/10 border-primary/20 text-primary w-fit">
            {getDisplayedHours(tier)}/month
          </div>
        )}
      </div>

      <div className="p-4 flex-grow">
        {tier.features && tier.features.length > 0 && (
          <ul className="space-y-3">
            {tier.features.map((feature) => (
              <li key={feature} className="flex items-center gap-2">
                <div className="size-5 rounded-full border border-primary/20 flex items-center justify-center">
                  <CheckIcon className="size-3 text-primary" />
                </div>
                <span className="text-sm">{feature}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-auto p-4">
        <Button
          onClick={() => handleSubscribe(tierPriceId)}
          disabled={buttonDisabled}
          variant={buttonVariant || 'default'}
          className={cn(
            'w-full font-medium transition-all duration-200',
            isCompact ? 'h-7 rounded-md text-xs' : 'h-10 rounded-full text-sm',
            buttonClassName,
            isPlanLoading && 'animate-pulse',
          )}
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
}

export function PricingSection({
  returnUrl = typeof window !== 'undefined' ? window.location.href : '/',
  showTitleAndTabs = true,
  hideFree = false,
  insideDialog = false
}: PricingSectionProps) {
  const [deploymentType, setDeploymentType] = useState<'cloud' | 'self-hosted'>(
    'cloud',
  );
  const [currentSubscription, setCurrentSubscription] =
    useState<SubscriptionStatus | null>(null);
  const [isLoading, setIsLoading] = useState<Record<string, boolean>>({});
  const [isFetchingPlan, setIsFetchingPlan] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const fetchCurrentPlan = async () => {
    setIsFetchingPlan(true);
    try {
      const subscriptionData = await getSubscription();
      console.log('Fetched Subscription Status:', subscriptionData);
      setCurrentSubscription(subscriptionData);
      setIsAuthenticated(true);
    } catch (error) {
      console.error('Error fetching subscription:', error);
      setCurrentSubscription(null);
      setIsAuthenticated(false);
    } finally {
      setIsFetchingPlan(false);
    }
  };

  const handlePlanSelect = (planId: string) => {
    setIsLoading((prev) => ({ ...prev, [planId]: true }));
  };

  const handleSubscriptionUpdate = () => {
    fetchCurrentPlan();
    setTimeout(() => {
      setIsLoading({});
    }, 1000);
  };

  useEffect(() => {
    fetchCurrentPlan();
  }, []);

  const handleTabChange = (tab: 'cloud' | 'self-hosted') => {
    if (tab === 'self-hosted') {
      const enterpriseSection = document.getElementById('enterprise');
      if (enterpriseSection) {
        const rect = enterpriseSection.getBoundingClientRect();
        const scrollTop =
          window.pageYOffset || document.documentElement.scrollTop;
        const offsetPosition = scrollTop + rect.top - 100;

        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth',
        });
      }
    } else {
      setDeploymentType(tab);
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
      className={cn("flex flex-col items-center justify-center gap-10 w-full relative", { "pb-20": !insideDialog })}
    >
      {showTitleAndTabs && (
        <>
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance">
              Choose the right plan for your needs
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Start with our free plan or upgrade to a premium plan for more
              usage hours
            </p>
          </SectionHeader>
          <div className="relative w-full h-full">
            <div className="absolute -top-14 left-1/2 -translate-x-1/2">
              <PricingTabs
                activeTab={deploymentType}
                setActiveTab={handleTabChange}
                className="mx-auto"
              />
            </div>
          </div>
        </>
      )}

      {deploymentType === 'cloud' && (
        <div className={cn(
          "grid gap-4 w-full max-w-6xl mx-auto",
          {
            "px-6": !insideDialog
          },
          (!hideFree || siteConfig.cloudPricingItems.filter((tier) => !hideFree || tier.price !== '$0').length > 2)
            ? "min-[650px]:grid-cols-2 min-[900px]:grid-cols-3" : "min-[650px]:grid-cols-2"
        )}>
          {siteConfig.cloudPricingItems.filter((tier) => !hideFree || tier.price !== '$0').map((tier) => (
            <PricingTier
              key={tier.name}
              tier={tier}
              currentSubscription={currentSubscription}
              isLoading={isLoading}
              isFetchingPlan={isFetchingPlan}
              onPlanSelect={handlePlanSelect}
              onSubscriptionUpdate={handleSubscriptionUpdate}
              isAuthenticated={isAuthenticated}
              returnUrl={returnUrl}
              insideDialog={insideDialog}
            />
          ))}
        </div>
      )}
    </section>
  );
}
