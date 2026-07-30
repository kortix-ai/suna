'use client';

import { AnimatedBg } from '@/components/ui/animated-bg';
import { type Icon as LucideIcon } from '@phosphor-icons/react';
import React from 'react';

interface PageHeaderProps {
  icon: LucideIcon;
  children: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ icon: Icon, children }) => {
  return (
    <div className="bg-background/80 relative flex items-center justify-center overflow-hidden rounded-2xl border sm:rounded-3xl">
      <AnimatedBg variant="header" blurMultiplier={1.3} sizeMultiplier={1.1} />
      <div className="relative z-20 px-4 py-8 text-center sm:px-8 sm:py-16">
        <div className="mx-auto max-w-3xl space-y-3 sm:space-y-6">
          <div className="bg-muted/80 border-border/50 inline-flex items-center justify-center rounded-full border p-2 sm:p-3">
            <Icon className="text-primary h-6 w-6 sm:h-8 sm:w-8" />
          </div>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">
            {children}
          </h1>
        </div>
      </div>
    </div>
  );
};
