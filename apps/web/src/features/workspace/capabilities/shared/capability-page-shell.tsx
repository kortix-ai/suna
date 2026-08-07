'use client';

import type { ReactNode } from 'react';

import {
  CapabilityScrollRootProvider,
  useCapabilityScrollRootRef,
} from './capability-scroll-root';

interface CapabilityPageShellProps {
  title: string;
  description: string;
  /** Page-level action(s) — a single button, or a cluster of them. Rendered
   *  in the header's right-hand group, **after** `search`. Pass several by
   *  wrapping them in one element; the shell does not space them for you. */
  action?: ReactNode;
  search?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
}

/**
 * Shared page shell for the three capability routes (agents, connectors,
 * skills). `max-w-5xl` is a deliberate departure from
 * `CustomizeSectionWrapper`'s `max-w-2xl` — a 3-up card grid does not fit in
 * `max-w-2xl`. These are standalone routed pages, not Customize sections; do
 * not reuse or edit `section-wrapper.tsx` for them.
 *
 * This element — not the window — is the page's scroll container, and it is
 * published through `CapabilityScrollRootProvider` because the connectors
 * catalogue observes it for infinite scroll. It has to be handed THIS element
 * rather than the viewport: the `(capabilities)` layout wraps the shell in
 * `overflow-hidden`, and a clipped target intersects the viewport never.
 *
 * The ref costs this shell nothing — no state, no re-render — so the two
 * capability pages that do not page are unaffected by the one that does.
 */
export function CapabilityPageShell({
  title,
  description,
  action,
  search,
  filters,
  children,
}: CapabilityPageShellProps) {
  const scrollRef = useCapabilityScrollRootRef();
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-10 pb-20 lg:py-14">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-foreground text-xl font-medium text-balance">{title}</h1>
            <p className="text-muted-foreground text-sm text-balance">{description}</p>
          </div>
          {/* Search and action are ONE right-hand group, search first. As three
              loose children of a `justify-between` row, `action` was pushed to
              the middle of the header — visually detached from both the
              heading it did not belong to and the search it sat next to. */}
          {search || action ? (
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
              {search ? <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">{search}</div> : null}
              {action}
            </div>
          ) : null}
        </header>
        {filters ? (
          <div className="flex flex-wrap items-center justify-between gap-2">{filters}</div>
        ) : null}
        <CapabilityScrollRootProvider scrollRef={scrollRef}>{children}</CapabilityScrollRootProvider>
      </div>
    </div>
  );
}
