'use client';

import React from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { normalizeIconName } from '@/lib/utils/icon-utils';

interface AgentAvatarProps {
  // For direct props
  iconName?: string | null;
  iconColor?: string;
  backgroundColor?: string;
  agentName?: string;
  isDefault?: boolean;

  // Common props
  size?: number;
  className?: string;
}

export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  // Direct props
  iconName: propIconName,
  iconColor: propIconColor = '#6B7280',
  backgroundColor: propBackgroundColor = '#F3F4F6',
  isDefault: propIsDefault,

  // Common props
  size = 16,
  className = ""
}) => {
  const iconName = propIconName;
  const iconColor = propIconColor;
  const backgroundColor = propBackgroundColor;
  const isDefaultAgent = propIsDefault ?? false;

  // Calculate responsive border radius - proportional to size
  const borderRadius = Math.min(size * 0.4, 16);
  const borderRadiusStyle = {
    borderRadius: `${borderRadius}px`
  };

  // Filter out any rounded-* classes from className to prevent overrides
  const filteredClassName = className
    .split(' ')
    .filter(cls => !cls.match(/^rounded(-[a-z0-9]+)?$/))
    .join(' ');

  if (isDefaultAgent) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-zinc-900 dark:bg-zinc-100 border-transparent",
          filteredClassName
        )}
        style={{ width: size, height: size, ...borderRadiusStyle }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/kortix-symbol.svg"
          alt="Kortix"
          className="flex-shrink-0 invert dark:invert-0"
          style={{ width: `${size * 0.5}px`, height: `${size * 0.5}px` }}
        />
      </div>
    );
  }

  if (iconName) {
    // Normalize and validate the icon name
    const normalizedIconName = normalizeIconName(iconName);
    
    // If icon name is invalid, fall through to default bot icon
    if (normalizedIconName) {
      try {
        return (
          <div
            className={cn(
              "flex items-center justify-center transition-colors border",
              filteredClassName
            )}
            style={{
              width: size,
              height: size,
              backgroundColor,
              ...borderRadiusStyle
            }}
          >
            <DynamicIcon
              name={normalizedIconName as any}
              size={size * 0.5}
              color={iconColor}
            />
          </div>
        );
      } catch (error) {
        // Fallback to default icon if DynamicIcon fails
        console.warn(`Invalid icon name: ${iconName}`, error);
      }
    }
  }

  // Fallback to default bot icon
  return (
    <div
      className={cn(
        "flex items-center justify-center bg-card border",
        filteredClassName
      )}
      style={{ width: size, height: size, ...borderRadiusStyle }}
    >
      <Bot
        size={size * 0.5}
        color="#6B7280"
      />
    </div>
  );
};
