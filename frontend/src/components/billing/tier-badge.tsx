'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import NextImage from 'next/image';
import { getPlanIcon } from './plan-utils';

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
  /** Show only icon (no text) - for circle variant */
  iconOnly?: boolean;
  /** Local mode flag */
  isLocal?: boolean;
}

const sizeConfig = {
  xxs: {
    height: 12,
    padding: 'px-1.5 py-0.5',
    circleSize: 'size-[12px]',
  },
  xs: {
    height: 14,
    padding: 'px-2 py-0.5',
    circleSize: 'size-[16px]',
  },
  sm: {
    height: 16,
    padding: 'px-2 py-0.5',
    circleSize: 'size-[20px]',
  },
  md: {
    height: 20,
    padding: 'px-2 py-1',
    circleSize: 'size-[24px]',
  },
  lg: {
    height: 24,
    padding: 'px-2.5 py-1',
    circleSize: 'size-[36px]',
  },
};

/**
 * TierBadge Component
 * 
 * A reusable component for displaying tier/plan badges with consistent styling.
 * Matches the implementation used in pricing-section.tsx for consistency.
 * 
 * Usage:
 * ```tsx
 * <TierBadge planName="Plus" size="lg" variant="default" />
 * <TierBadge planName="Pro" size="sm" variant="circle" iconOnly />
 * ```
 */
export function TierBadge({
  planName,
  size = 'sm',
  variant = 'default',
  className,
  iconOnly = false,
  isLocal = false,
}: TierBadgeProps) {
  const planIcon = getPlanIcon(planName, isLocal);
  const config = sizeConfig[size];

  // Debug logging
  React.useEffect(() => {
    if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
      console.log('[TierBadge]', {
        planName,
        planIcon,
        size,
        height: config.height,
        variant,
        iconOnly,
        isLocal,
        willRender: !!planIcon || (!iconOnly && variant !== 'circle')
      });
    }
  }, [planName, planIcon, size, variant, iconOnly, isLocal, config.height]);

  // If no icon (e.g., Basic tier), return null or text only
  if (!planIcon) {
    console.log('[TierBadge] No icon found for plan:', planName);
    if (iconOnly || variant === 'circle') {
      if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
        console.log('[TierBadge] Returning null - no icon for plan:', planName);
      }
      return null;
    }
    return (
      <span className={cn('text-[13px] font-medium text-muted-foreground leading-tight', className)}>
        {planName || 'Basic'}
      </span>
    );
  }

  // Circle variant - white circle with icon inside (for Credits Display)
  if (variant === 'circle') {
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-white rounded-full flex-shrink-0',
          config.circleSize,
          className
        )}
      >
        <NextImage
          src={planIcon}
          alt={planName}
          width={config.height * 0.6}
          height={config.height * 0.6}
          className="w-auto h-auto object-contain"
        />
      </div>
    );
  }

  // Default variant - matches pricing-section.tsx exactly
  // Black background in light mode, transparent in dark mode
  return (
    <div className="flex items-center">
      <NextImage
        src={planIcon}
        alt={planName}
        width={config.height}
        height={config.height}
        style={{ height: `${config.height}px`, width: 'auto' }}
        className={cn("w-auto object-contain", className)}
      />
    </div>
  );
}


