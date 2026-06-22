'use client';

import React, { useState } from 'react';
import { Key as KeyRound, Power as Plug } from '@mynaui/icons-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { SecretIntakeForm } from './secret-intake-form';
import { ConnectorIntake } from './connector-intake';
import type { SetupLinkKind } from './util';

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
  const fallbackLabel = kind === 'secret' ? 'Add secret' : 'Connect';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5',
          'align-baseline text-sm font-medium text-foreground',
          'hover:bg-muted transition-colors duration-150',
        )}
      >
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        {children || fallbackLabel}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {kind === 'secret' ? 'Add a project secret' : 'Connect an app'}
            </DialogTitle>
            <DialogDescription>
              {kind === 'secret'
                ? 'Enter the value below. It’s encrypted and the agent never sees it.'
                : 'Authorize the app in one click — no keys touch the chat or the repo.'}
            </DialogDescription>
          </DialogHeader>
          {kind === 'secret' ? (
            <SecretIntakeForm token={token} compact />
          ) : (
            <ConnectorIntake token={token} compact />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
