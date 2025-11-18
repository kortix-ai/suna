import React from 'react';
import { shouldUseRevenueCat, isRevenueCatConfigured } from '@/lib/billing/provider';
import { RevenueCatPricingSection } from './RevenueCatPricingSection';
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
      <RevenueCatPricingSection
        onClose={props.onClose}
        onPurchaseComplete={props.onSubscriptionUpdate}
        customTitle={props.customTitle}
      />
    );
  }

  return <PricingSection {...props} />;
}

