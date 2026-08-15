'use client';

import { ShieldCheckIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { PoliciesPanel } from '@/components/projects/policies-panel';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

/**
 * Project-wide connector rules.
 *
 * It used to sit at the far right of the capabilities tab bar, so it stayed
 * reachable from Connectors, Skills and Commands. That bar is gone — Customize
 * is a rail now — and these are connector rules, so it lives in the Connectors
 * pane header instead of following a rail that also lists Billing.
 *
 * Opens as a Sheet, not a Modal: the panel is a long CRUD list that benefits
 * from a persistent side surface. No Hint — the button already shows its
 * label. No `before:-inset` hit expand — without `relative` that pseudo
 * stretches to the nearest positioned ancestor and steals clicks from its
 * neighbours.
 */
export function GlobalRulesControl({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Global rules"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground shrink-0 gap-1.5 active:scale-[0.96]"
      >
        <ShieldCheckIcon className="size-4" />
        <span className="hidden md:block">Global rules</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-xl md:max-w-2xl"
        >
          {/* `pr-12` clears the sheet's own close button, which is absolutely
              positioned at `top-4 right-4`. */}
          <SheetHeader className="border-border shrink-0 space-y-1 border-b px-5 py-4 pr-12 text-left">
            <SheetTitle className="text-base font-medium">Global rules</SheetTitle>
            <SheetDescription className="text-xs text-pretty">
              Approval rules that apply to every connector in this project.
            </SheetDescription>
          </SheetHeader>
          {/* The body is the only scroller, so the panel's save bar can stick
              to its bottom edge. */}
          <SheetBody className="min-h-0 gap-0 px-5 py-5">
            <PoliciesPanel projectId={projectId} />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
