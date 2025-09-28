'use client';

import React from 'react';
import { LucideIcon } from 'lucide-react';
import { Ripple } from '@/components/ui/ripple';

interface PageHeaderProps {
  icon: LucideIcon;
  children: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ icon: Icon, children }) => {
  return (
    <div className="relative overflow-hidden rounded-3xl flex items-center justify-center border bg-background">
      <div className="relative px-8 py-16 text-center">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="inline-flex items-center justify-center rounded-full bg-muted p-3">
            <Icon className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground">
            {children}
          </h1>
        </div>
      </div>
      <Ripple/>
    </div>
  );
}; 