'use client';

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { useCreditBalance, useSubscription, billingKeys } from '@/hooks/billing';
import { useAuth } from '@/components/AuthProvider';
import { Skeleton } from '@/components/ui/skeleton';
import { isLocalMode } from '@/lib/config';
import { getPlanName } from '@/components/billing/plan-utils';
import { TierBadge } from '@/components/billing/tier-badge';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { formatCredits } from '@/lib/utils/credit-formatter';

export function CreditsDisplay() {
  const { user } = useAuth();
  const { data: balance, isLoading: balanceLoading } = useCreditBalance(!!user);
  const { data: subscriptionData, isLoading: subscriptionLoading } = useSubscription({ enabled: !!user });
  const [showPlanModal, setShowPlanModal] = useState(false);
  const queryClient = useQueryClient();
  const isLocal = isLocalMode();
  const isLoading = balanceLoading || subscriptionLoading;
  
  // Get plan name from subscription data
  const planName = getPlanName(subscriptionData, isLocal);

  // Debug logging
  React.useEffect(() => {
    if (balance) {
      console.log('[CreditsDisplay] Balance data:', balance);
    }
    if (subscriptionData) {
      console.log('[CreditsDisplay] Subscription data:', subscriptionData);
      console.log('[CreditsDisplay] Computed plan name:', planName);
      console.log('[CreditsDisplay] Tier key:', subscriptionData.tier_key);
      console.log('[CreditsDisplay] Tier name:', subscriptionData.tier?.name);
    }
  }, [balance, subscriptionData, planName]);

  if (!user) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 border-[1.5px] border-border/60 dark:border-border rounded-full px-3.5 py-2 h-[41px] bg-background">
        <Skeleton className="h-4 w-24 bg-muted/50 dark:bg-muted" />
      </div>
    );
  }

  const credits = balance?.balance || 0;
  const formattedCredits = formatCredits(credits);

  const handleClick = () => {
    setShowPlanModal(true);
  };

  const handleModalClose = (open: boolean) => {
    setShowPlanModal(open);
    
    // When modal closes, refetch billing data to get latest credits
    if (!open) {
      console.log('[CreditsDisplay] Modal closed - refetching billing data');
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
    }
  };

  return (
    <>
      {/* Unified Credits Display with Plus Button */}
      <button
        onClick={handleClick}
        className={cn(
          "group flex items-center gap-2.5 border-[1.5px] rounded-full pl-3.5 pr-2.5 py-2 h-[41px]",
          "bg-background dark:bg-background",
          "border-border/60 dark:border-border",
          "hover:bg-accent/30 dark:hover:bg-accent/20 hover:border-border dark:hover:border-border/80",
          "transition-all duration-200 cursor-pointer",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        )}
      >
        {/* Tier Badge - Left side */}
        <TierBadge 
          planName={planName} 
          variant="default" 
          size="md" 
          isLocal={isLocal} 
        />

        {/* Divider - Only show if tier badge exists (non-Basic plans) */}
        {planName && planName !== 'Basic' && (
          <div className="h-5 w-[1px] bg-border/40 dark:bg-border/60" />
        )}

        {/* Credits amount */}
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-[15px] font-medium text-foreground dark:text-foreground leading-none tabular-nums">
            {formattedCredits}
          </span>
          <span className="text-[13px] font-medium text-muted-foreground/50 dark:text-muted-foreground/60 leading-none whitespace-nowrap">
            Credits
          </span>
        </div>

        {/* Divider before Plus */}
        <div className="h-5 w-[1px] bg-border/40 dark:bg-border/60 ml-0.5" />

        {/* Plus Icon */}
        <div className="flex items-center justify-center h-[32px] w-[32px] rounded-full bg-accent/20 dark:bg-accent/30 group-hover:bg-accent/40 dark:group-hover:bg-accent/50 transition-colors">
          <Plus className="h-4 w-4 text-foreground/70 dark:text-foreground/80 group-hover:text-foreground transition-colors" />
        </div>
      </button>

      {/* Plan Selection Modal */}
      <PlanSelectionModal
        open={showPlanModal}
        onOpenChange={handleModalClose}
        returnUrl={typeof window !== 'undefined' ? window.location.href : '/'}
      />
    </>
  );
}

