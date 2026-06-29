'use client';

import { Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { infoToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { useAuth } from '@/features/providers/auth-provider';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { marketplaceItemHref } from '@/lib/marketplace-slug';
import { AddToProjectModal } from './add-to-project-modal';

/**
 * Auth-aware install control for the public detail page.
 * - Signed in  → opens the add-to-project modal (with a project picker).
 * - Signed out → "Sign in to add" + a copyable CLI install command.
 */
export function MarketplaceAddButton({ item }: { item: MarketplaceItem }) {
  const { user, isLoading } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const installCommand = `kortix marketplace install ${item.name}`;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      infoToast('Copied install command', { description: installCommand });
      setTimeout(() => setCopied(false), 1600);
    } catch {
      infoToast('Copy failed', { description: installCommand });
    }
  };

  if (isLoading) {
    return (
      <Button variant="secondary" size="sm" disabled className="shrink-0">
        <Icon.Plus className="size-4" />
        Add to project
      </Button>
    );
  }

  if (user) {
    return (
      <>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setAddOpen(true)}>
          <Icon.Plus className="size-4" />
          Add to project
        </Button>
        <AddToProjectModal item={item} open={addOpen} onOpenChange={setAddOpen} />
      </>
    );
  }

  return (
    <ButtonGroup className="shrink-0">
      {/* <Button variant="secondary" size="sm" asChild>
        <Link href={`/auth?redirect=${encodeURIComponent(marketplaceItemHref(item.id))}`}>
          <Icon.Plus className="size-4" />
          Sign in to add
        </Link>
      </Button> */}
      <Button
        variant="secondary"
        size="icon"
        onClick={copyCommand}
        aria-label="Copy install command"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </ButtonGroup>
  );
}
