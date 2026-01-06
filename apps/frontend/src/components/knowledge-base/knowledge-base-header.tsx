'use client';

import React from 'react';
import { BookOpen } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';

export const KnowledgeBasePageHeader = () => {
  return (
    <PageHeader icon={BookOpen}>
      <div className="space-y-4">
        <div className="text-4xl font-semibold tracking-tight">
          <span className="text-primary">Knowledge Base</span>
        </div>
      </div>
    </PageHeader>
  );
};
