'use client';

import React from 'react';
import { Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MarketplaceSectionHeaderProps {
  title: string;
  subtitle: string;
  icon?: React.ReactNode;
  iconColor?: string;
}

export const MarketplaceSectionHeader = ({ 
  title, 
  subtitle, 
  icon = <Shield className="h-5 w-5 text-white" />,
  iconColor = 'bg-gradient-to-br from-blue-500 to-blue-600',
}: MarketplaceSectionHeaderProps) => {
  return (
    <div className="flex items-center gap-3">
      <div className={cn("flex h-10 w-10 items-center justify-center rounded-2xl", iconColor)}>
        {icon}
      </div>
      <div>
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}; 