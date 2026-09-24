/**
 * PricingTierBadge — the plan name in a pill: "Free", "Team", "Enterprise",
 * the API's plan families (`plan.label`). The legacy Basic / Plus / Pro / Ultra
 * artwork is gone (Jay, 2026-09-23): no account shows those names any more.
 */

import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/utils/theme';

interface PricingTierBadgeProps {
  /** The plan family label: 'Free', 'Team' or 'Enterprise'. */
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
 * A full-radius light grey pill with dark text in both themes. The text size
 * is derived from `height` instead of a Text variant — one badge renders at
 * 12–32pt.
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
        // `--border` light, L 89.8%, in both themes.
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

export function PricingTierBadge({ planName, size = 'lg' }: PricingTierBadgeProps) {
  if (!planName?.trim()) return null;
  return <PlanNameBadge planName={planName.trim()} height={sizeConfig[size].height} />;
}
