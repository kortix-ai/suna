'use client';

import * as LucideIcons from 'lucide-react';
import { LucideIcon } from 'lucide-react';

interface IconRendererProps {
  iconName: string;
  className?: string;
  size?: number;
}

export const IconRenderer = ({ iconName, className, size = 24 }: IconRendererProps) => {
  // Get the icon component from Lucide
  const IconComponent = (LucideIcons as any)[iconName] as LucideIcon;
  
  // Fallback to a default icon if the specified icon doesn't exist
  if (!IconComponent) {
    const FallbackIcon = LucideIcons.Circle;
    return <FallbackIcon className={className} size={size} />;
  }
  
  return <IconComponent className={className} size={size} />;
};

// Helper function to get integration icon
export const getIntegrationIcon = (iconName: string, className?: string, size?: number) => {
  return <IconRenderer iconName={iconName} className={className} size={size} />;
};
