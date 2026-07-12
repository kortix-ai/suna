'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { AddToProjectModal } from './add-to-project-modal';

/**
 * Primary "Add to project" CTA for a skill/agent/command detail page — the
 * big, full-width counterpart to `MarketplaceCloneButton` (projects). Signed
 * in opens the project-picker modal; signed out routes through auth back to
 * this page.
 */
export function MarketplaceAddButton({ item }: { item: MarketplaceItem }) {
  const { user, isLoading } = useAuth();
  const pathname = usePathname();
  const [addOpen, setAddOpen] = useState(false);

  if (isLoading) {
    return (
      <Button variant="default" disabled className="w-full gap-1.5">
        Add to project
      </Button>
    );
  }

  if (user) {
    return (
      <>
        <Button variant="default" className="w-full gap-1.5" onClick={() => setAddOpen(true)}>
          Add to project
          <ArrowRight className="size-4" />
        </Button>
        <AddToProjectModal item={item} open={addOpen} onOpenChange={setAddOpen} />
      </>
    );
  }

  return (
    <Button variant="default" className="w-full gap-1.5" asChild>
      <Link href={`/auth?redirect=${encodeURIComponent(pathname)}`}>
        Sign in to add to a project
        <ArrowRight className="size-4" />
      </Link>
    </Button>
  );
}
