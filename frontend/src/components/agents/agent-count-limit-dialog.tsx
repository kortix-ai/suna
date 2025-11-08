'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { UpgradeDialog } from '@/components/ui/upgrade-dialog';
import { PricingSection } from '@/components/billing/pricing';

interface AgentCountLimitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentCount: number;
  limit: number;
  tierName: string;
}

export const AgentCountLimitDialog: React.FC<AgentCountLimitDialogProps> = ({
  open,
  onOpenChange,
  currentCount,
  limit,
  tierName,
}) => {
  const returnUrl = typeof window !== 'undefined' ? window.location.href : '/';

  const getNextTierRecommendation = () => {
    if (tierName === 'free' || tierName === 'none') {
      return {
        name: 'Starter',
        price: '$29/month',
        agentLimit: 5,
      };
    } else if (tierName.includes('tier_2_20')) {
      return {
        name: 'Professional',
        price: '$79/month',
        agentLimit: 'Unlimited',
      };
    } else if (tierName.includes('tier_6_50')) {
      return {
        name: 'Business',
        price: '$199/month',
        agentLimit: 'Unlimited',
      };
    } else if (tierName.includes('tier_12_100')) {
      return {
        name: 'Enterprise',
        price: '$499/month',
        agentLimit: 'Unlimited',
      };
    }
    return null;
  };

  const nextTier = getNextTierRecommendation();

  return (
    <UpgradeDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={AlertTriangle}
      title="Agent Limit Reached"
      description="You've reached the maximum number of agents allowed on your current plan."
      theme="warning"
      size="xl"
      contentClassName="w-full max-w-full pb-4"
    >
      <div className="w-full">
        <PricingSection
          returnUrl={returnUrl}
          showTitleAndTabs={false}
          insideDialog={true}
          noPadding={true}
        />
      </div>
    </UpgradeDialog>
  );
}; 