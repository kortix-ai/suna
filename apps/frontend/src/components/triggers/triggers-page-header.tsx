'use client';

import React from 'react';
import { Zap } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';

export const TriggersPageHeader = () => {
  return (
    <PageHeader icon={Zap}>
      <div className="space-y-4">
        <div className="text-4xl font-semibold tracking-tight">
          <span className="text-primary">Triggers</span>
        </div>
      </div>
    </PageHeader>
  );
};
