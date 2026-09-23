/**
 * Pricing Tier Badge Component
 * 
 * Matches frontend TierBadge component exactly
 * Shows icon badges for pricing cards (24px height for lg size)
 */

import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/utils/theme';
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

type TierIconComponent = React.ComponentType<{ width: number; height: number }>;

/**
 * Plan name in a pill that matches the tier artwork: a full-radius light grey
 * fill with dark text in BOTH themes (the SVGs are theme-invariant, so a
 * "Team" pill must look like a "Plus" pill beside it). The artwork sets its
 * label at half the pill height, so the text size is derived from `height`
 * instead of a Text variant — one badge renders at 12–32pt.
 */
function PlanNameBadge({ planName, height }: { planName: string; height: number }) {
  return (
    <View
      accessibilityLabel={planName}
      style={{
        height,
        borderRadius: height / 2,
        paddingHorizontal: Math.round(height * 0.45),
        justifyContent: 'center',
        alignItems: 'center',
        // Artwork fill is a light grey (L≈88%); `--border` light is L 89.8%.
        backgroundColor: THEME.light.border,
      }}>
      <Text
        numberOfLines={1}
        className="font-roobert-medium"
        style={{
          fontSize: Math.round(height * 0.55),
          lineHeight: height,
          color: THEME.light.foreground,
        }}>
        {planName}
      </Text>
    </View>
  );
}

/** Brand badge artwork for a plan name - matches frontend plan-utils.ts logic. */
function tierIconFor(planName: string | undefined): TierIconComponent | null {
  const plan = planName?.toLowerCase();
  if (plan?.includes('ultra')) return UltraSvg;
  if (plan?.includes('pro') || plan?.includes('business') || plan?.includes('enterprise') || plan?.includes('scale') || plan?.includes('max')) {
    return ProSvg;
  }
  if (plan?.includes('plus')) return PlusSvg;
  if (plan?.includes('free') || plan?.includes('basic')) return BasicSvg;
  return null;
}

/**
 * PricingTierBadge Component
 *
 * Displays the plan badge. Legacy tiers (Basic, Plus, Pro, Ultra) use their
 * brand artwork. Every other plan name ("Team", "Admin") gets a pill in the
 * artwork's shape and colours, so a plan is never unlabelled.
 */
export function PricingTierBadge({
  planName,
  size = 'lg',
}: PricingTierBadgeProps) {
  const config = sizeConfig[size];
  const TierIcon = tierIconFor(planName);

  if (!planName?.trim()) {
    return null;
  }

  if (!TierIcon) {
    return <PlanNameBadge planName={planName.trim()} height={config.height} />;
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

