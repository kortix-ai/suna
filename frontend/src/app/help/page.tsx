'use client';

import * as React from 'react';
import {
  DocsHeader,
  DocsBody,
  DocsCard,
} from '@/components/ui/docs-index';
import { Separator } from '@/components/ui/separator';
import { 
  Coins, 
  MessageCircle,
} from 'lucide-react';

const breadcrumbs = [
  { title: 'Help Center' }
];

export default function HelpCenterPage() {
  return (
    <>
      <DocsHeader
        title="Help Center"
        subtitle="Get answers to common questions and learn more about Kortix"
        breadcrumbs={breadcrumbs}
        lastUpdated="November 2024"
        showSeparator
        size="lg"
        className="mb-8 sm:mb-12"
      />

      <DocsBody className="mb-8">
        <h2 id="billing-usage">Billing & Usage</h2>
        <p className="mb-6">
          Understand how credits work and manage your subscription.
        </p>

        <div className="grid gap-4 mb-12">
          <DocsCard
            title="What are Credits?"
            description="Learn about credit types, how they're consumed, and pricing"
            icon={Coins}
            clickable
            onClick={() => window.location.href = '/help/credits'}
          />
        </div>
      </DocsBody>
    </>
  );
}

