'use client';

/** Small pieces the trigger composer's blocks share. */

import { Button } from '@/components/ui/button';
import { DisclosureTrigger } from '@/components/ui/disclosure';
import { CaretDownIcon } from '@phosphor-icons/react';

import type { ComposerDraft } from './trigger-composer-logic';

/** Patch the draft. Blocks never own state of their own. */
export type PatchDraft = (next: Partial<ComposerDraft>) => void;

/** A problem shown at its field, in the colour of a refusal. */
export function InlineError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-destructive text-xs leading-relaxed text-pretty">
      {message}
    </p>
  );
}

/** The row that folds a block away: a ghost button with a caret that turns when open. Put it inside a `Disclosure className="group"`. */
export function FoldTrigger({ children }: { children: React.ReactNode }) {
  return (
    <DisclosureTrigger>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground -mx-2 w-[calc(100%+1rem)] justify-between px-2"
      >
        {children}
        <CaretDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </Button>
    </DisclosureTrigger>
  );
}
