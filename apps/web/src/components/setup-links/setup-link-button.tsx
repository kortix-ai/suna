'use client';

import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import { KeyIcon as KeyRound, PlugIcon as Plug } from '@phosphor-icons/react';
import React, { useState } from 'react';
import { Button } from '../ui/button';
import { ConnectorIntake } from './connector-intake';
import { SecretIntakeForm } from './secret-intake-form';
import { setupLinkChipLabel, type SetupLinkKind } from './util';

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * In-chat renderer for an agent-minted setup link. Instead of navigating away,
 * it shows an inline CTA chip that opens a modal with the fill-in form (secret)
 * or the 1-click connect (connector). Used by the markdown link interceptor.
 */
export function SetupLinkButton({
  kind,
  token,
  children,
}: {
  kind: SetupLinkKind;
  token: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = kind === 'secret' ? KeyRound : Plug;
  const label = setupLinkChipLabel(
    textOf(children),
    token,
    kind === 'secret' ? 'Enter credentials' : 'Connect app',
  );

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className={cn('max-w-full')} size="sm">
        <span className="bg-primary/[0.06] flex size-5 shrink-0 items-center justify-center rounded-full">
          <Icon className="text-muted-foreground size-3" />
        </span>
        <span className="truncate">{label}</span>
      </Button>

      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>{kind === 'secret' ? 'Add a project secret' : 'Connect an app'}</ModalTitle>
            <ModalDescription>
              {kind === 'secret'
                ? 'Enter the value below. It’s encrypted and the agent never sees it.'
                : 'Authorize the app in one click — no keys touch the chat or the repo.'}
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] overflow-y-auto">
            {kind === 'secret' ? (
              <SecretIntakeForm token={token} compact />
            ) : (
              <ConnectorIntake token={token} compact />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
