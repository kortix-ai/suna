'use client';

import React from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { MessageSquareMore } from 'lucide-react';
import { cn } from '@/lib/utils';
import { normalizeIconName } from '@/lib/utils/icon-utils';

interface ThreadIconProps {
  iconName?: string | null;
  className?: string;
  size?: number;
}

export function ThreadIcon({
  iconName,
  className,
  size = 16
}: ThreadIconProps) {
  // If no icon name is provided, use MessageSquareMore as fallback
  if (!iconName) {
    return (
      <MessageSquareMore 
        className={cn("shrink-0", className)} 
        size={size}
      />
    );
  }

  // Normalize and validate the icon name
  const normalizedIconName = normalizeIconName(iconName);
  
  // If icon name is invalid, use fallback
  if (!normalizedIconName) {
    return (
      <MessageSquareMore 
        className={cn("shrink-0", className)} 
        size={size}
      />
    );
  }

  // Use DynamicIcon for lucide-react icons
  try {
    return (
      <DynamicIcon 
        name={normalizedIconName as any} 
        size={size} 
        className={cn("shrink-0", className)}
      />
    );
  } catch (error) {
    // Fallback to default icon if DynamicIcon fails
    console.warn(`Invalid icon name: ${iconName}`, error);
    return (
      <MessageSquareMore 
        className={cn("shrink-0", className)} 
        size={size}
      />
    );
  }
}
