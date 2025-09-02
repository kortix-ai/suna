'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { DocsMobileHeader } from './docs-mobile-header';

interface DocsLayoutProps {
  children: React.ReactNode;
}

export const DocsLayout = ({ children }: DocsLayoutProps) => {
  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="fixed inset-0 bg-gradient-to-b from-primary/5 via-primary/3 to-background/10" />
      <div className="fixed inset-0 backdrop-blur-[2px] bg-background/40" />
      <DocsMobileHeader />
      <div className="relative z-10 flex min-h-screen">
        {children}
      </div>
    </div>
  );
}; 