'use client';

import React, { useEffect } from 'react';
import { 
  Zap
} from 'lucide-react';
import { ComposioConnectionsSection } from '../../../../components/agents/composio/composio-connections-section';
import { PageHeader } from '@/components/ui/page-header';
import { copy } from '@/copy';

export default function AppProfilesPage() {

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <div className="space-y-8">
        <PageHeader icon={Zap}>
          <span className="text-primary">{copy.credentials.title}</span>
        </PageHeader>
        <ComposioConnectionsSection />
      </div>
    </div>
  );
} 
