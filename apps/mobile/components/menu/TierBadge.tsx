import * as React from 'react';
import { View } from 'react-native';
import BasicSvg from '@/assets/brand/tiers/basic.svg';
import PlusSvg from '@/assets/brand/tiers/plus.svg';
import ProSvg from '@/assets/brand/tiers/pro.svg';
import UltraSvg from '@/assets/brand/tiers/ultra.svg';
import type { TierType } from './types';

interface TierBadgeProps {
  tier: TierType;
  size?: 'small' | 'large';
}

/**
 * TierBadge Component
 * 
 * Displays tier badge SVG which includes both icon and tier name.
 * Four variants: Basic (gray), Plus (pink gradient), Pro (orange gradient), Ultra (rainbow gradient).
 * 
 * The SVG badges are pre-designed and contain:
 * - Kortix icon
 * - Tier name text
 * - Background styling
 * 
 * Size variants:
 * - Small: Height 20px (for pricing cards, billing page)
 * - Large: Height 24px (for larger displays)
 */
export function TierBadge({ tier, size = 'small' }: TierBadgeProps) {
  const isSmall = size === 'small';
  
  // SVG badges have fixed aspect ratios:
  // Basic: 50x24, Plus: 59x24, Pro: 55x24, Ultra: 63x24
  // Scale based on desired height
  const height = isSmall ? 20 : 24;
  
  // Select appropriate SVG component
  const TierIcon = 
    tier === 'Basic' ? BasicSvg :
    tier === 'Plus' ? PlusSvg : 
    tier === 'Pro' ? ProSvg : 
    UltraSvg;

  // Calculate width based on original SVG aspect ratio
  const getWidth = () => {
    const aspectRatios = {
      Basic: 50 / 24,
      Plus: 59 / 24,
      Pro: 55 / 24,
      Ultra: 63 / 24,
    };
    return Math.round(height * aspectRatios[tier]);
  };

  const width = getWidth();

  return (
    <View style={{ height, width }}>
      <TierIcon width={width} height={height} />
    </View>
  );
}

