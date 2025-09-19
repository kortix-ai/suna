'use client';

import React from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { MessageSquareMore } from 'lucide-react';
import { cn } from '@/lib/utils';

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

  // Use DynamicIcon for lucide-react icons
  return (
    <DynamicIcon 
      name={iconName as any} 
      size={size} 
      className={cn("shrink-0", className)}
    />
  );
}
