'use client'

import React from 'react';
import { Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AppIconProps {
  toolCall?: any;
  appSlug?: string;
  size?: number;
  className?: string;
  fallbackIcon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

export function AppIcon({ toolCall, appSlug, size = 20, className, fallbackIcon: FallbackIcon = Wrench }: AppIconProps) {
  return <FallbackIcon className={className} style={{ width: size, height: size }} />;
}
