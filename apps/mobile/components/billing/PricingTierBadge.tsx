/**
 * Pricing Tier Badge Component
 * 
 * Matches frontend TierBadge component exactly
 * Shows icon badges for pricing cards (24px height for lg size)
 */

import * as React from 'react';
import { View } from 'react-native';
import PlusSvg from '@/assets/brand/tiers/plus.svg';
import ProSvg from '@/assets/brand/tiers/pro.svg';
import UltraSvg from '@/assets/brand/tiers/ultra.svg';
import BasicSvg from '@/assets/brand/tiers/basic.svg';

interface PricingTierBadgeProps {
  /** Plan name (e.g., 'Basic', 'Plus', 'Pro', 'Ultra') */
  planName: string;
  /** Size variant - matches frontend: xxs, xs, sm, md, lg, xl */
  size?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}

const sizeConfig = {
  xxs: { height: 12 },
  xs: { height: 14 },
  sm: { height: 16 },
  md: { height: 20 },
  lg: { height: 24 }, // Matches frontend lg size
  xl: { height: 32 }, // Larger size for billing status page
};

/**
 * PricingTierBadge Component
 * 
 * Displays tier icon badge for pricing cards.
 * Matches frontend TierBadge behavior exactly.
 */
export function PricingTierBadge({
  planName,
  size = 'lg',
}: PricingTierBadgeProps) {
  const plan = planName?.toLowerCase();
  const config = sizeConfig[size];

  // Select appropriate SVG component - matches frontend plan-utils.ts logic
  let TierIcon: React.ComponentType<{ width: number; height: number }> | null = null;
  
  if (plan?.includes('ultra')) {
    TierIcon = UltraSvg;
  } else if (plan?.includes('pro') || plan?.includes('business') || plan?.includes('enterprise') || plan?.includes('scale') || plan?.includes('max')) {
    TierIcon = ProSvg;
  } else if (plan?.includes('plus')) {
    TierIcon = PlusSvg;
  } else if (plan?.includes('free') || plan?.includes('basic')) {
    TierIcon = BasicSvg;
  }

  if (!TierIcon) {
    return null;
  }

  // Frontend uses height for both width and height, maintaining aspect ratio
  // SVGs have different widths (50, 55, 59, 63) but same height (24)
  // For React Native, we need to calculate width based on aspect ratio
  // Typical SVG aspect ratio is ~2.5:1 (width:height), so we'll use a multiplier
  const aspectRatio = 2.5; // Approximate aspect ratio for tier badges
  const calculatedWidth = config.height * aspectRatio;
  
  return (
    <View style={{ height: config.height, width: calculatedWidth }}>
      <TierIcon width={calculatedWidth} height={config.height} />
    </View>
  );
}

