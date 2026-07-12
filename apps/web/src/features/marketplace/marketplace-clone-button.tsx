'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import type { MarketplaceItem } from '@/lib/marketplace-client';

/**
 * Primary "Install" CTA for a `registry:project` item — installing a whole
 * project spins up a brand-new project from it, so this routes into the normal
 * "New Project" flow on `/projects`, pre-seeded with this item
 * (`project-create-modal.tsx` picks up `?clone=`). That flow now also starts a
 * setup session right away that wires up the template's integrations. Sized as
 * the page's primary CTA since installing a project is the marketplace's main
 * growth action.
 */
export function MarketplaceCloneButton({ item }: { item: MarketplaceItem }) {
  const { user, isLoading } = useAuth();
  const cloneHref = `/projects?clone=${encodeURIComponent(item.id)}`;

  if (isLoading) {
    return (
      <Button variant="default" disabled className="w-full gap-1.5">
        Install project
      </Button>
    );
  }

  if (user) {
    return (
      <Button variant="default" className="w-full gap-1.5" asChild>
        <Link href={cloneHref}>
          Install project
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    );
  }

  return (
    <Button variant="default" className="w-full gap-1.5" asChild>
      <Link href={`/auth?redirect=${encodeURIComponent(cloneHref)}`}>
        Sign in to install
        <ArrowRight className="size-4" />
      </Link>
    </Button>
  );
}
