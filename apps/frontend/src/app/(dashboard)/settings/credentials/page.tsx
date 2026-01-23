'use client';

import React, { useEffect } from 'react';
import { 
  Zap
} from 'lucide-react';
import { ComposioConnectionsSection } from '../../../../components/agents/composio/composio-connections-section';
import { PageHeader } from '@/components/ui/page-header';

export default function AppProfilesPage() {

  return (
    <div className="container mx-auto max-w-7xl px-3 sm:px-4 py-4 sm:py-8">
      <div className="space-y-4 sm:space-y-8">
        <PageHeader icon={Zap}>
          <span className="text-primary text-lg sm:text-xl">App Credentials</span>
        </PageHeader>
        <ComposioConnectionsSection />
      </div>
    </div>
  );
} 