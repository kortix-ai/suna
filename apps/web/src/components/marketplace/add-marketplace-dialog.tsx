'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAddMarketplaceSource } from '@/hooks/marketplace';

/**
 * "Add a marketplace" — point Kortix at a custom registry (a GitHub repo, a
 * registry.json URL, or a local folder). Items merge into the catalog. We're
 * compatible out of the box with SKILL.md repos and Claude-Code/Codex
 * `marketplace.json` plugin sets — no registry.json required. (Curated/featured
 * marketplaces live in the Marketplaces tab.)
 */
export function AddMarketplaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [address, setAddress] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [sparse, setSparse] = useState('');
  const add = useAddMarketplaceSource();

  const reset = () => {
    setAddress('');
    setGitRef('');
    setSparse('');
  };

  const onSubmit = async () => {
    const addr = address.trim();
    if (!addr) return;
    const sparsePaths = sparse
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await add.mutateAsync({ address: addr, gitRef: gitRef.trim() || undefined, sparsePaths });
      successToast('Marketplace added', { description: 'Its items now appear in the catalog.' });
      reset();
      onOpenChange(false);
    } catch (e) {
      errorToast('Could not add marketplace', { description: (e as Error).message });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
          <DialogTitle>
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddMarketplaceDialogJsxTextAddAMarketplace6a70ab2e',
            )}
          </DialogTitle>
          <DialogDescription>
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddMarketplaceDialogJsxTextPointAtA282139da',
            )}
            <span className="font-mono">SKILL.md</span>{' '}
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddMarketplaceDialogJsxTextFilesAndImport6d37db6e',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-5">
          <div className="space-y-1.5">
            <label htmlFor="mp-address" className="text-foreground text-sm font-medium">
              Source
            </label>
            <Input
              id="mp-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={tI18nHardcoded.raw(
                'autoComponentsMarketplaceAddMarketplaceDialogJsxAttrPlaceholderOwnerRepo0cb2a2dd',
              )}
              autoFocus
            />
            <p className="text-muted-foreground text-xs">
              e.g. <span className="font-mono">anthropics/skills</span> or{' '}
              <span className="font-mono">garrytan/gstack</span>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="mp-ref" className="text-foreground text-sm font-medium">
                {tI18nHardcoded.raw(
                  'autoComponentsMarketplaceAddMarketplaceDialogJsxTextGitRef62b0636a',
                )}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="mp-ref"
                value={gitRef}
                onChange={(e) => setGitRef(e.target.value)}
                placeholder="main"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="mp-sparse" className="text-foreground text-sm font-medium">
                {tI18nHardcoded.raw(
                  'autoComponentsMarketplaceAddMarketplaceDialogJsxTextSparsePaths842b3808',
                )}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="mp-sparse"
                value={sparse}
                onChange={(e) => setSparse(e.target.value)}
                placeholder="plugins/codex"
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddMarketplaceDialogJsxTextSparsePathsScan23f718ab',
            )}
          </p>
        </div>

        <div className="border-border/60 bg-muted/30 flex items-center justify-end gap-2 border-t px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!address.trim() || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add marketplace'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
