'use client';

import React, { useState } from 'react';
import { KeyRound, Plug } from 'lucide-react';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import { SecretIntakeForm } from './secret-intake-form';
import { ConnectorIntake } from './connector-intake';
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-full border bg-popover py-1 pr-3 pl-2',
          'align-middle text-sm font-medium text-foreground',
          'hover:bg-muted active:scale-[0.96]',
          'transition-[background-color,scale] duration-150',
        )}
      >
        <span className="bg-primary/[0.06] flex size-5 shrink-0 items-center justify-center rounded-full">
          <Icon className="size-3 text-muted-foreground" />
        </span>
        <span className="truncate">{label}</span>
      </button>

      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>
              {kind === 'secret' ? 'Add a project secret' : 'Connect an app'}
            </ModalTitle>
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
