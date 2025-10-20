/**
 * ThreadIcon Component
 * 
 * Dynamically renders thread icons based on the iconName string from the backend.
 * Backend stores icon names in kebab-case format (e.g., "message-circle", "brain").
 * Falls back to MessageSquareMore if no icon name is provided or icon not found.
 */

import React from 'react';
import { MessageSquareMore } from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';
import * as LucideIcons from 'lucide-react-native';

interface ThreadIconProps {
  iconName?: string | null;
  size?: number;
  className?: string;
}

/**
 * Converts kebab-case icon names to PascalCase for Lucide lookup
 * Examples: "message-circle" -> "MessageCircle", "brain" -> "Brain"
 */
function kebabToPascal(str: string): string {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

export function ThreadIcon({
  iconName,
  size = 20,
  className = 'text-foreground',
}: ThreadIconProps) {
  // If no icon name is provided, use MessageSquareMore as fallback
  if (!iconName) {
    return (
      <Icon 
        as={MessageSquareMore} 
        size={size} 
        className={className}
      />
    );
  }

  // Convert kebab-case to PascalCase for Lucide icon lookup
  const iconKey = kebabToPascal(iconName.trim());
  
  // Get the icon component from lucide-react-native
  const IconComponent = (LucideIcons as any)[iconKey];
  
  // If icon not found, use fallback
  if (!IconComponent) {
    console.warn(`⚠️ ThreadIcon - Icon "${iconName}" (${iconKey}) not found in lucide-react-native, using fallback`);
    return (
      <Icon 
        as={MessageSquareMore} 
        size={size} 
        className={className}
      />
    );
  }

  return (
    <Icon 
      as={IconComponent} 
      size={size} 
      className={className}
    />
  );
}

