'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAddMarketplaceSource } from '@/hooks/marketplace';

/**
 * "Add a marketplace" — point Kortix at a custom registry (a GitHub repo, a
 * registry.json URL, or a local folder). Items merge into the catalog. We're
 * compatible out of the box with SKILL.md repos and Claude-Code/Codex
 * `marketplace.json` plugin sets — no registry.json required. (Curated/featured
 * marketplaces live in the Marketplaces tab.)
 */
export function AddMarketplaceModal({
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
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddMarketplaceModalJsxTextAddAMarketplace6a70ab2e',
            )}
          </ModalTitle>
          <ModalDescription>
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddMarketplaceModalJsxTextPointAtA282139da',
            )}
            <span className="font-mono">SKILL.md</span>{' '}
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceAddMarketplaceModalJsxTextFilesAndImport6d37db6e',
            )}
          </ModalDescription>
        </ModalHeader>

        <ModalBody>
          <FieldGroup className="gap-4">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="mp-address">Source</FieldLabel>
              <Input
                id="mp-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={tI18nHardcoded.raw(
                  'autoComponentsMarketplaceAddMarketplaceModalJsxAttrPlaceholderOwnerRepo0cb2a2dd',
                )}
                autoFocus
              />
              <FieldDescription>e.g. anthropics/skills or garrytan/gstack</FieldDescription>
            </Field>

            <FieldGroup className="grid grid-cols-2 gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="mp-ref">
                  {tI18nHardcoded.raw(
                    'autoComponentsMarketplaceAddMarketplaceModalJsxTextGitRef62b0636a',
                  )}
                  <span className="text-muted-foreground font-normal"> (optional)</span>
                </FieldLabel>
                <Input
                  id="mp-ref"
                  value={gitRef}
                  onChange={(e) => setGitRef(e.target.value)}
                  placeholder="main"
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="mp-sparse">
                  {tI18nHardcoded.raw(
                    'autoComponentsMarketplaceAddMarketplaceModalJsxTextSparsePaths842b3808',
                  )}
                  <span className="text-muted-foreground font-normal"> (optional)</span>
                </FieldLabel>
                <Input
                  id="mp-sparse"
                  value={sparse}
                  onChange={(e) => setSparse(e.target.value)}
                  placeholder="plugins/codex"
                />
              </Field>
            </FieldGroup>

            <FieldDescription>
              {tI18nHardcoded.raw(
                'autoComponentsMarketplaceAddMarketplaceModalJsxTextSparsePathsScan23f718ab',
              )}
            </FieldDescription>
          </FieldGroup>
        </ModalBody>

        <ModalFooter className="sm:justify-between">
          <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={!address.trim() || add.isPending}>
            {add.isPending ? 'Adding…' : 'Add marketplace'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
