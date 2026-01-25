'use client';

import React from 'react';
import { LucideIcon } from 'lucide-react';
import { AnimatedBg } from '@/components/ui/animated-bg';

interface PageHeaderProps {
  icon: LucideIcon;
  children: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ icon: Icon, children }) => {
  return (
    <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl flex items-center justify-center border bg-background/80 backdrop-blur-sm">
      <AnimatedBg variant="header" blurMultiplier={1.3} sizeMultiplier={1.1} />
      <div className="relative px-4 sm:px-8 py-8 sm:py-16 text-center z-20">
        <div className="mx-auto max-w-3xl space-y-3 sm:space-y-6">
          <div className="inline-flex items-center justify-center rounded-full bg-muted/80 backdrop-blur-sm p-2 sm:p-3 border border-border/50">
            <Icon className="h-6 w-6 sm:h-8 sm:w-8 text-primary" />
          </div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight text-foreground">
            {children}
          </h1>
        </div>
      </div>
    </div>
  );
}; 