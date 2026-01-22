'use client';

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAccountState, accountStateSelectors, invalidateAccountState } from '@/hooks/billing';
import { useAuth } from '@/components/AuthProvider';
import { Skeleton } from '@/components/ui/skeleton';
import { isLocalMode } from '@/lib/config';
import { TierBadge } from '@/components/billing/tier-badge';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { trackCtaUpgrade } from '@/lib/analytics/gtm';
import { formatCredits } from '@agentpress/shared';

export function CreditsDisplay() {
  const { user } = useAuth();
  const { data: accountState, isLoading } = useAccountState({ enabled: !!user });
  const [showPlanModal, setShowPlanModal] = useState(false);
  const queryClient = useQueryClient();
  const isLocal = isLocalMode();
  
  const planName = accountStateSelectors.planName(accountState);

  if (!user) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 sm:gap-2 border-[1.5px] border-border/60 dark:border-border rounded-full px-2 sm:px-3 h-9 bg-background">
        <Skeleton className="h-4 w-16 sm:w-24 bg-muted/50 dark:bg-muted" />
      </div>
    );
  }

  const credits = accountStateSelectors.totalCredits(accountState);
  const formattedCredits = formatCredits(credits);

  const handleClick = () => {
    trackCtaUpgrade();
    setShowPlanModal(true);
  };

  const handleModalClose = (open: boolean) => {
    setShowPlanModal(open);
    
    if (!open) {
      // Invalidate account state when modal closes (in case of changes)
      invalidateAccountState(queryClient, true);
    }
  };

  return (
    <>
      <button
        onClick={handleClick}
        className={cn(
          "group flex items-center gap-1.5 sm:gap-2 border-[1.5px] rounded-full px-1.5 sm:px-2 h-9",
          "bg-background dark:bg-background",
          "border-border/60 dark:border-border",
          "hover:bg-accent/30 dark:hover:bg-accent/20 hover:border-border dark:hover:border-border/80",
          "transition-all duration-200 cursor-pointer touch-manipulation",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        )}
      >
        <TierBadge 
          planName={planName} 
          variant="default" 
          size="md" 
          isLocal={isLocal} 
        />
        <div className="flex items-baseline gap-1 sm:gap-1.5 min-w-0 flex-shrink-0">
          <span className="text-sm sm:text-[15px] font-medium text-foreground dark:text-foreground leading-none tabular-nums">
            {formattedCredits}
          </span>
          <span className="hidden sm:inline text-[13px] font-medium text-muted-foreground dark:text-muted-foreground/60 leading-none whitespace-nowrap">
            Credits
          </span>
        </div>
        <div className="flex items-center justify-center h-5 w-5 sm:h-6 sm:w-6 rounded-full bg-black dark:bg-white group-hover:bg-black/90 dark:group-hover:bg-white/90 transition-colors flex-shrink-0">
          <Plus className="h-2.5 w-2.5 sm:h-3 sm:w-3 text-white dark:text-black font-bold stroke-[2.5]" />
        </div>
      </button>
      <PlanSelectionModal
        open={showPlanModal}
        onOpenChange={handleModalClose}
        returnUrl={typeof window !== 'undefined' ? window.location.href : '/'}
      />
    </>
  );
}
