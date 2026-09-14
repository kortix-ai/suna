'use client';

import { createConnector } from '@kortix/sdk';
import { MonitorIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
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
import { ComputerTunnelManager } from '@/features/tunnel/tunnel-overview';
import {
  isConnectorConnectionSlugAvailable,
  normalizeConnectorConnectionSlug,
  proposeConnectorConnectionSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';

export function ComputersAddFlow({
  projectId,
  open,
  existingSlugs,
  canWrite,
  onClose,
  onAdded,
}: {
  projectId: string;
  open: boolean;
  existingSlugs: readonly string[];
  canWrite: boolean;
  onClose: () => void;
  onAdded: (slug?: string) => void;
}) {
  if (!canWrite || !open) return null;
  return (
    <ComputersAddFlowContent
      projectId={projectId}
      existingSlugs={existingSlugs}
      onClose={onClose}
      onAdded={onAdded}
    />
  );
}

function ComputersAddFlowContent({
  projectId,
  existingSlugs,
  onClose,
  onAdded,
}: {
  projectId: string;
  existingSlugs: readonly string[];
  onClose: () => void;
  onAdded: (slug?: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const initialSlug = proposeConnectorConnectionSlug('Computer Tunnel', existingSlugs);
  const [name, setName] = useState('Computer Tunnel');
  const [slug, setSlug] = useState(initialSlug);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const add = useMutation({
    mutationFn: () =>
      createConnector(projectId, {
        slug,
        name: name.trim(),
        provider: 'computer',
        tunnel_ids: selectedIds,
        authorization_strategy: 'project',
        create_only: true,
      }),
    onSuccess: () => {
      successToast(tI18nComplete('text29f396e2d238', { value0: name.trim() }));
      onAdded(slug);
      onClose();
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text9bb62f4c5a61')),
  });

  const slugAvailable = isConnectorConnectionSlugAvailable(slug, existingSlugs);
  const valid = name.trim().length > 0 && slugAvailable && selectedIds.length > 0;

  return (
    <Modal open onOpenChange={(next) => !next && !add.isPending && onClose()}>
      <ModalContent className="lg:max-w-3xl">
        <ModalHeader>
          <div className="flex items-start gap-3">
            <span className="bg-kortix-blue/15 text-kortix-blue flex size-10 shrink-0 items-center justify-center rounded-sm">
              <MonitorIcon className="size-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <ModalTitle>{tI18nComplete.raw('text206588f5fd84')}</ModalTitle>
              <ModalDescription>{tI18nComplete.raw('textcbfd0bbb1891')}</ModalDescription>
            </div>
          </div>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !add.isPending) add.mutate();
          }}
        >
          <ModalBody className="max-h-[75vh] space-y-5 overflow-y-auto">
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="computers-profile-name">
                  {tI18nComplete.raw('textd3663280e101')}
                </FieldLabel>
                <Input
                  id="computers-profile-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  variant="popover"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="computers-profile-slug">
                  {tI18nComplete.raw('textd15387ecc6c5')}
                </FieldLabel>
                <Input
                  id="computers-profile-slug"
                  value={slug}
                  onChange={(event) =>
                    setSlug(normalizeConnectorConnectionSlug(event.target.value))
                  }
                  variant="popover"
                  className="font-mono text-xs"
                  aria-invalid={slug.length > 0 && !slugAvailable}
                />
                {!slugAvailable ? (
                  <p className="text-destructive text-xs">
                    {tI18nComplete.raw('text5cb2baf7db08')}
                  </p>
                ) : null}
              </Field>
            </FieldGroup>

            <section className="space-y-3">
              <div className="space-y-1">
                <FieldLabel>{tI18nComplete.raw('textc061da196eae')}</FieldLabel>
                <p className="text-muted-foreground text-xs text-pretty">
                  {tI18nComplete.raw('texta5285ecc196c')}
                </p>
              </div>
              <ComputerTunnelManager
                canWrite
                selectedIds={selectedIds}
                onSelectedIdsChange={setSelectedIds}
                selectionDisabled={add.isPending}
              />
            </section>
          </ModalBody>
          <ModalFooter>
            <Button
              type="button"
              variant="outline-ghost"
              disabled={add.isPending}
              onClick={onClose}
            >
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={!valid || add.isPending}>
              {add.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('text61d30d997d13')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
