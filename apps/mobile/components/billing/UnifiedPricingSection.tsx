import React from 'react';
import { shouldUseRevenueCat, isRevenueCatConfigured } from '@/lib/billing/provider';
import { PlanPage } from '@/components/settings/PlanPage';
import { PricingSection } from './PricingSection';

interface UnifiedPricingSectionProps {
  returnUrl?: string;
  showTitleAndTabs?: boolean;
  hideFree?: boolean;
  insideDialog?: boolean;
  noPadding?: boolean;
  onSubscriptionUpdate?: () => void;
  customTitle?: string;
  onClose?: () => void;
}

export function UnifiedPricingSection(props: UnifiedPricingSectionProps) {
  const useRevenueCat = shouldUseRevenueCat() && isRevenueCatConfigured();

  if (useRevenueCat) {
    return (
      <PlanPage
        visible={true}
        onClose={props.onClose}
        onPurchaseComplete={props.onSubscriptionUpdate}
        customTitle={props.customTitle}
      />
    );
  }

  return <PricingSection {...props} />;
}

