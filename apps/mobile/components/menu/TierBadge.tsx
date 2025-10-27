import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
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
 * Displays tier badge with Kortix brandmark and tier name.
 * Three variants: Plus (pink gradient), Pro (orange gradient), Ultra (rainbow gradient).
 * 
 * Design Specifications (Figma: 89-8016):
 * - Small size: 12x10px icon, 13.33px text (for profile cards)
 * - Large size: 104x87px icon, 116px text (for showcase)
 * - Font: Roobert-Medium
 * - Gap: 4px (small), 35px (large)
 * - Ultra has gradient text with linear gradient
 * - Plus & Pro have white text
 */
export function TierBadge({ tier, size = 'small' }: TierBadgeProps) {
  const isSmall = size === 'small';
  // Scale icon to match text height better - 16x13 for small size
  const iconSize = isSmall ? { width: 20, height: 20 } : { width: 104, height: 87 };
  const textSize = isSmall ? 'text-[16px]' : 'text-[116px]';
  const gapSize = isSmall ? 'gap-1' : 'gap-[35px]';

  // Select appropriate SVG component
  const TierIcon = tier === 'Plus' ? PlusSvg : tier === 'Pro' ? ProSvg : UltraSvg;

  return (
    <View className={`flex-row items-center ${gapSize}`}>
      {/* Tier Icon */}
      <View style={iconSize}>
        <TierIcon width={iconSize.width} height={iconSize.height} />
      </View>

      {/* Tier Text */}
      {tier === 'Ultra' ? (
        // Ultra with gradient text using MaskedView
        <MaskedView
          maskElement={
            <Text 
              className={`${textSize} font-roobert-medium`}
              style={{ backgroundColor: 'transparent' }}
            >
              {tier}
            </Text>
          }
        >
          <LinearGradient
            colors={['#23D3FF', '#FDF5E0', '#FFC78C', '#FF1B07']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            locations={[0.073, 0.545, 0.919, 1.0]}
          >
            <Text 
              className={`${textSize} font-roobert-medium`}
              style={{ opacity: 0 }}
            >
              {tier}
            </Text>
          </LinearGradient>
        </MaskedView>
      ) : (
        // Plus & Pro with white text
        <Text className={`${textSize} font-roobert-medium text-white`}>
          {tier}
        </Text>
      )}
    </View>
  );
}

