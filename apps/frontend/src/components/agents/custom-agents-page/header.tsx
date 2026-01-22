'use client';

import React from 'react';
import { Bot } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';

export const AgentsPageHeader = () => {
  return (
    <PageHeader icon={Bot}>
      <div className="space-y-2 sm:space-y-4">
        <div className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight">
          <span className="text-primary">AI Workers</span>
        </div>
      </div>
    </PageHeader>
  );
};
