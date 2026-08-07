'use client';

import { CheckIcon } from '@phosphor-icons/react';

import Loading from '@/components/ui/loading';
import { phaseStatuses } from '@/features/workspace/new/provision-phases';
import type { ProvisionPhase } from '@kortix/sdk';

/**
 * Replaces the `/new` FORM (not just its submit button) while a create is in
 * flight — see `new-workspace-page.tsx`'s cross-fade between the two. Owns
 * the ONE `bg-popover rounded-md border px-4 py-5` panel itself, matching the
 * page's existing hand-composed card (`new-workspace-page.tsx:180`,
 * `account-picker.tsx`'s doc comment) — never a second, nested card; `Card`
 * (`card.tsx:35`) is a transparent grid system here, not a bordered panel,
 * and this page has already had to remove one nested `InfoBanner` for the
 * exact same reason.
 *
 * `current` is the REAL phase `POST /projects/provision-stream` last
 * reported — see `provision-phases.ts`'s doc comment on why this checklist
 * never guesses. `aria-live="polite"` + `aria-busy` on the panel (not on each
 * row) is what makes a screen reader announce progress as `phaseStatuses`
 * advances, without re-announcing the whole list's static rows.
 */
export function ProvisionProgress({
  workspaceName,
  current,
}: {
  workspaceName: string;
  current: ProvisionPhase | null;
}) {
  return (
    <div
      className="bg-popover flex flex-col gap-3 rounded-md border px-4 py-5"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="text-foreground text-sm font-medium">Creating {workspaceName}</p>
      <ol className="flex flex-col gap-2">
        {phaseStatuses(current).map(({ phase, label, state }) => (
          <li key={phase} className="flex items-center gap-2 text-sm">
            {/* `aria-hidden` on the SLOT, not on each icon: `Loading`
                (`loading.tsx`) doesn't forward arbitrary props to its `<svg>`,
                so `aria-hidden` passed directly to it would silently do
                nothing — the wrapper hides whichever of the three renders,
                uniformly. The phase LABEL beside it is the accessible
                content; the glyph is decoration. */}
            <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
              {state === 'done' ? (
                <CheckIcon className="text-kortix-green size-3.5" />
              ) : state === 'active' ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <span className="bg-border size-1.5 rounded-full" />
              )}
            </span>
            <span className={state === 'pending' ? 'text-muted-foreground/60' : 'text-foreground'}>
              {label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
