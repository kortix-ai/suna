'use client';

import React, { useState } from 'react';
import { useCreditBalance, useSubscription } from '@/hooks/use-billing-v2';
import { useAuth } from '@/components/AuthProvider';
import { Skeleton } from '@/components/ui/skeleton';
import { isLocalMode } from '@/lib/config';
import { getPlanName } from '@/components/billing/plan-utils';
import { TierBadge } from '@/components/billing/tier-badge';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { cn } from '@/lib/utils';

export function CreditsDisplay() {
  const { user } = useAuth();
  const { data: balance, isLoading: balanceLoading } = useCreditBalance(!!user);
  const { data: subscriptionData, isLoading: subscriptionLoading } = useSubscription(!!user);
  const [showPlanModal, setShowPlanModal] = useState(false);
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
      <div className="flex items-center gap-2 border-[1.5px] border-border rounded-full px-4 py-2 h-[41px]">
        <Skeleton className="h-4 w-20" />
      </div>
    );
  }

  const credits = balance?.balance || 0;
  const formattedCredits = Math.floor(credits).toLocaleString();

  const handleClick = () => {
    setShowPlanModal(true);
  };

  return (
    <>
      <button
        onClick={handleClick}
        className={cn(
          "flex items-center gap-2 border-[1.5px] border-border rounded-full px-4 py-2.5 h-[41px]",
          "hover:bg-accent/50 transition-colors cursor-pointer",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        )}
      >
        {/* Kortix Icon with glow */}
        <div className="relative h-[12.9px] w-[15.48px] flex-shrink-0">
          <div className="absolute h-[12.9px] left-0 top-0 w-[15.48px]">
            <img
              src="/kortix-icon.svg"
              alt="Kortix"
              className="w-full h-full object-contain"
            />
          </div>
          <div
            className="absolute blur-[1.387px] filter h-[10.4px] left-[1.5px] mix-blend-color-dodge opacity-50 top-[1.25px] w-[12.48px]"
          >
            <img
              src="/kortix-icon.svg"
              alt=""
              className="w-full h-full object-contain"
            />
          </div>
        </div>

        {/* Credits amount */}
        <div className="flex items-baseline gap-1">
          <span className="text-[14px] font-medium text-foreground leading-none">
            {formattedCredits}
          </span>
          <span className="text-[14px] font-medium text-muted-foreground/25 leading-none">
            credits
          </span>
        </div>

        {/* Tier Badge - TierBadge handles its own visibility based on plan */}
        <TierBadge 
          planName={planName} 
          variant="circle" 
          size="sm" 
          iconOnly 
          isLocal={isLocal} 
        />
      </button>

      {/* Plan Selection Modal */}
      <PlanSelectionModal
        open={showPlanModal}
        onOpenChange={setShowPlanModal}
        returnUrl={typeof window !== 'undefined' ? window.location.href : '/'}
      />
    </>
  );
}

