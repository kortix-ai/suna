/**
 * TierBadge Component
 * 
 * Reusable component for displaying tier/plan badges with consistent styling.
 * Matches the frontend TierBadge implementation.
 * 
 * Usage:
 * ```tsx
 * <TierBadge planName="Plus" size="sm" variant="default" />
 * <TierBadge planName="Pro" size="xs" variant="circle" />
 * ```
 */

import * as React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { getPlanIcon } from '@/lib/billing/plan-utils';
import PlusSvg from '@/assets/brand/tiers/plus.svg';
import ProSvg from '@/assets/brand/tiers/pro.svg';
import UltraSvg from '@/assets/brand/tiers/ultra.svg';
import BasicSvg from '@/assets/brand/tiers/basic.svg';

export type TierBadgeSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg';
export type TierBadgeVariant = 'default' | 'circle';

interface TierBadgeProps {
    /** Plan name (e.g., 'Basic', 'Plus', 'Pro', 'Ultra') */
    planName: string;
    /** Size variant */
    size?: TierBadgeSize;
    /** Visual variant */
    variant?: TierBadgeVariant;
    /** Additional className */
    className?: string;
    /** Local mode flag */
    isLocal?: boolean;
}

const sizeConfig = {
    xxs: {
        height: 16,
        circleSize: 16,
    },
    xs: {
        height: 18,
        circleSize: 20,
    },
    sm: {
        height: 22,
        circleSize: 24,
    },
    md: {
        height: 28,
        circleSize: 32,
    },
    lg: {
        height: 32,
        circleSize: 40,
    },
};

/**
 * TierBadge Component
 * 
 * A reusable component for displaying tier/plan badges with consistent styling.
 */
export function TierBadge({
    planName,
    size = 'sm',
    variant = 'default',
    className,
    isLocal = false,
}: TierBadgeProps) {
    const { colorScheme } = useColorScheme();
    const planIconType = getPlanIcon(planName, isLocal);
    const config = sizeConfig[size];

    // If no icon (shouldn't happen now that Basic has an icon), return null
    if (!planIconType) {
        return null;
    }

    // Select appropriate SVG component
    const TierIcon =
        planIconType === 'ultra' ? UltraSvg :
            planIconType === 'pro' ? ProSvg :
                planIconType === 'plus' ? PlusSvg :
                    BasicSvg;

    // Circle variant - white circle with icon inside
    if (variant === 'circle') {
        return (
            <View
                className="flex items-center justify-center bg-white rounded-full flex-shrink-0"
                style={{
                    width: config.circleSize,
                    height: config.circleSize,
                }}
            >
                <TierIcon
                    width={config.height * 0.6}
                    height={config.height * 0.6}
                />
            </View>
        );
    }

    // Default variant - just the icon (SVG maintains its aspect ratio)
    return (
        <TierIcon height={config.height} />
    );
}
