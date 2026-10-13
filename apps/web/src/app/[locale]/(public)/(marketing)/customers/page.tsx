'use client';

import { StoriesSection } from '@/features/marketing/site/blocks';
import type { ReactNode } from 'react';

/**
 * `/customers` — how companies run on agents. Big cards, one per story; the
 * stories and their accuracy gate live in `features/marketing/stories/content.ts`.
 */
export default function CustomersPage(): ReactNode {
  return (
    <div className="bg-background relative pt-16">
      <StoriesSection showAll={false} as="h1" />
    </div>
  );
}
