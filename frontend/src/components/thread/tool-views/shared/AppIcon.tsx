'use client'

import React from 'react';
import { Wrench } from 'lucide-react';
import { useComposioToolkitIcon } from '@/hooks/composio/use-composio';
import { extractAppSlugFromToolCall } from '@/components/thread/utils';
import { cn } from '@/lib/utils';

interface AppIconProps {
  toolCall?: any;
  appSlug?: string;
  size?: number;
  className?: string;
  fallbackIcon?: React.ElementType;
}

export function AppIcon({ toolCall, appSlug, size = 20, className, fallbackIcon: FallbackIcon = Wrench }: AppIconProps) {
  const extractedSlug = appSlug || (toolCall ? extractAppSlugFromToolCall(toolCall) : null);
  
  const { data: iconData } = useComposioToolkitIcon(extractedSlug || '', {
    enabled: !!extractedSlug
  });

  if (iconData?.icon_url) {
    
    return (
      <img
        src={iconData.icon_url}
        alt="App icon"
        className={cn("object-cover", className)}
        style={{ width: size, height: size }}
        onError={(e) => {
          const target = e.target as HTMLImageElement;
          target.style.display = 'none';
        }}
      />
    );
  }

  return <FallbackIcon className={className} style={{ width: size, height: size }} />;
}
