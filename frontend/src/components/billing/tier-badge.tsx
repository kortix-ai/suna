'use client';

import React from 'react';
import { cn } from '@/lib/utils';
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
    height: 14,
    padding: 'px-1.5 py-0.5',
    circleSize: 'size-[14px]',
  },
  xs: {
    height: 18,
    padding: 'px-2 py-0.5',
    circleSize: 'size-[18px]',
  },
  sm: {
    height: 22,
    padding: 'px-2 py-0.5',
    circleSize: 'size-[24px]',
  },
  md: {
    height: 26,
    padding: 'px-2 py-1',
    circleSize: 'size-[28px]',
  },
  lg: {
    height: 32,
    padding: 'px-2.5 py-1',
    circleSize: 'size-[40px]',
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

  // If no icon (e.g., Basic tier), return null or text only
  if (!planIcon) {
    if (iconOnly || variant === 'circle') {
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
    const iconSize = Math.round(config.height * 0.6);
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-white rounded-full flex-shrink-0',
          config.circleSize,
          className
        )}
      >
        {/* Use regular img for SVG icons to avoid Next.js Image aspect ratio warnings */}
        <img
          src={planIcon}
          alt={planName}
          className="object-contain"
          style={{ width: `${iconSize}px`, height: `${iconSize}px` }}
        />
      </div>
    );
  }

  // Default variant - matches pricing-section.tsx exactly
  // Black background in light mode, transparent in dark mode
  // Use regular img for SVG icons to avoid Next.js Image aspect ratio warnings
  return (
    <div className="flex items-center">
      <img
        src={planIcon}
        alt={planName}
        className={cn("object-contain", className)}
        style={{ height: `${config.height}px`, width: 'auto' }}
      />
    </div>
  );
}


