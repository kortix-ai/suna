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
}

/**
 * A full-radius light grey pill with dark text in both themes, 20pt tall
 * (the `md` size was the only size a caller used).
 */
export function PricingTierBadge({ planName }: PricingTierBadgeProps) {
  const name = planName.trim();
  const height = 20;
  return (
    <View
      accessibilityLabel={name}
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
        {name}
      </Text>
    </View>
  );
}
