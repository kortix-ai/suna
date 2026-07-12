'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import type { MarketplaceItem } from '@/lib/marketplace-client';

/**
 * Clone CTA for a `registry:project` item's detail page. Unlike
 * `MarketplaceAddButton` (installs into an existing project via a modal),
 * cloning creates a brand-new project — so this just routes into the normal
 * "New Project" flow on `/projects`, pre-seeded with this item
 * (`project-create-modal.tsx` picks up `?clone=`), same as the existing
 * `?new=1` auto-open pattern used after GitHub-connect. Sized as the page's
 * primary CTA (not `size="sm"` like the skill/agent "Add to project" button)
 * since cloning is the marketplace's main growth action.
 */
export function MarketplaceCloneButton({ item }: { item: MarketplaceItem }) {
  const { user, isLoading } = useAuth();
  const cloneHref = `/projects?clone=${encodeURIComponent(item.id)}`;

  if (isLoading) {
    return (
      <Button variant="default" disabled className="w-full gap-1.5">
        Clone project
      </Button>
    );
  }

  if (user) {
    return (
      <Button variant="default" className="w-full gap-1.5" asChild>
        <Link href={cloneHref}>
          Clone project
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    );
  }

  return (
    <Button variant="default" className="w-full gap-1.5" asChild>
      <Link href={`/auth?redirect=${encodeURIComponent(cloneHref)}`}>
        Sign in to clone
        <ArrowRight className="size-4" />
      </Link>
    </Button>
  );
}
