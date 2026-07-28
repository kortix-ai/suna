'use client';

/**
 * The ONE collapsed "Advanced" disclosure on the Agents screen.
 *
 * The old detail pane stacked four cards in a third rail beside the list and
 * the editor — assignments, the manifest governance block, the model and the
 * access scope, all expanded, all at once. Everything that is not "which model
 * does this agent run on" now lives behind this single collapsed row, per the
 * simplification rule of one Advanced disclosure per screen. Nothing is
 * removed: opening it restores the full set.
 */

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';

export function AgentAdvanced({
  children,
  summary = 'Assignments, governance & access scope',
}: {
  children: ReactNode;
  /** One line hinting at what is inside, so nothing hides without a trace. */
  summary?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Disclosure variant="outline" className="overflow-hidden" open={open} onOpenChange={setOpen}>
      <DisclosureTrigger variant="outline">
        <button
          type="button"
          aria-label="Advanced"
          className="hover:bg-muted/40 focus-visible:ring-kortix-blue/50 flex w-full items-center gap-2 px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
          <span className="text-foreground text-sm font-medium">Advanced</span>
          <span className="text-muted-foreground/70 ml-auto truncate text-xs">{summary}</span>
        </button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <div className="space-y-3 p-4">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}

export default AgentAdvanced;
