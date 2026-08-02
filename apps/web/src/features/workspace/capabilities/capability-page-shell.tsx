'use client';

import type { ReactNode } from 'react';

interface CapabilityPageShellProps {
  title: string;
  description: string;
  search?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
}

/**
 * Shared page shell for the three capability routes (connectors, skills,
 * commands). `max-w-5xl` is a deliberate departure from
 * `CustomizeSectionWrapper`'s `max-w-2xl` — a 3-up card grid does not fit in
 * `max-w-2xl`. These are standalone routed pages, not Customize sections; do
 * not reuse or edit `section-wrapper.tsx` for them.
 */
export function CapabilityPageShell({
  title,
  description,
  search,
  filters,
  children,
}: CapabilityPageShellProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-10 pb-20 lg:py-14">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-foreground text-xl font-medium text-balance">{title}</h1>
            <p className="text-muted-foreground text-sm text-balance">{description}</p>
          </div>
          {search ? <div className="w-full shrink-0 sm:max-w-xs">{search}</div> : null}
        </header>
        {filters ? (
          <div className="flex flex-wrap items-center justify-between gap-2">{filters}</div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
