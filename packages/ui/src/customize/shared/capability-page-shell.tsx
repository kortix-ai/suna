'use client';

import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { cn } from '../../internal/lib/utils';
import { createContext, type ReactNode, useContext } from 'react';

import { CapabilityScrollRootProvider, useCapabilityScrollRootRef } from './capability-scroll-root';

interface CapabilityPageShellProps {
  title: string;
  /** One line. Longer explanations go in `titleAddon` (an info hover card). */
  description: string;
  /** Rendered inline after the title, e.g. an info button. */
  titleAddon?: ReactNode;
  /** Page-level action(s) — a single button, or a cluster of them. Rendered
   *  in the header's right-hand group, **after** `search`. Pass several by
   *  wrapping them in one element; the shell does not space them for you. */
  action?: ReactNode;
  search?: ReactNode;
  filters?: ReactNode;
  /** The `max-w-7xl` column, for a gallery whose tiles need the width (Apps:
   *  a 5xl column made four-across tiles 230px, too small to read an App). */
  wide?: boolean;
  /**
   * Stack the header at every width: the heading on top, then search and
   * actions on one full-width row with the search taking what is left. For a
   * shell rendered in a narrow column (Triggers, beside an open trigger),
   * where the side-by-side header is wider than the column. Default off.
   */
  stacked?: boolean;
  children: ReactNode;
}

/**
 * Set by the agent page around a resource screen it shows in agent scope
 * (Access > Connectors, Runtime > Model, Triggers). The shell then drops its
 * own title (the agent page's tabs name the view), runs full width on the
 * agent page's gutter, and draws `lead` (the Access view switcher) as the
 * first row inside its scroller, so the switcher scrolls with the content.
 */
export interface CapabilityShellEmbed {
  agentName: string;
  lead?: ReactNode;
}
const CapabilityShellEmbedContext = createContext<CapabilityShellEmbed | null>(null);
export const CapabilityShellEmbedProvider = CapabilityShellEmbedContext.Provider;
export function useCapabilityShellEmbed(): CapabilityShellEmbed | null {
  return useContext(CapabilityShellEmbedContext);
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
  titleAddon,
  action,
  search,
  filters,
  wide = false,
  stacked = false,
  children,
}: CapabilityPageShellProps) {
  const scrollRef = useCapabilityScrollRootRef();
  const embed = useCapabilityShellEmbed();
  if (embed) {
    return (
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-5 px-4 pt-5 pb-24 md:px-8">
          {embed.lead}
          <header className={cn('flex flex-col gap-3', !stacked && 'md:flex-row md:items-center md:justify-between')}>
            <h2 className="sr-only">{title}</h2>
            <p className="text-muted-foreground min-w-0 text-sm text-pretty md:max-w-xl">{description}</p>
            {search || action ? (
              <div className={cn('flex w-full shrink-0 items-center gap-2', !stacked && 'md:w-auto')}>
                {search ? <div className={cn('min-w-0 flex-1', !stacked && 'md:w-64 md:flex-none')}>{search}</div> : null}
                {action}
              </div>
            ) : null}
          </header>
          {filters ? <div className="flex flex-wrap items-center justify-between gap-2">{filters}</div> : null}
          <CapabilityScrollRootProvider scrollRef={scrollRef}>{children}</CapabilityScrollRootProvider>
        </div>
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={
          wide
            ? 'mx-auto w-full max-w-7xl space-y-5 px-4 py-10 pb-20 md:px-8 lg:py-14'
            : 'mx-auto w-full max-w-5xl space-y-5 px-4 py-10 pb-20 lg:py-14'
        }
      >
        <header
          className={cn(
            'flex flex-col gap-3',
            !stacked && 'sm:flex-row sm:items-start sm:justify-between',
          )}
        >
          {/* `sm:max-w-md` fixes where the description wraps. Without it the
              text column took whatever the right-hand group left, and that
              group fills in after data and permissions resolve — so the
              description re-wrapped and the header grew 20px under the
              reader (Agents 52 → 72px, Secrets 92 → 112px). */}
          <div className="space-y-1 sm:max-w-md">
            <div className="flex items-center gap-1">
              {/* The page's own sidebar opener: Customize has no top bar. It
                  hides itself while the sidebar is docked open. */}
              <SidebarToggle className="-ml-2" />
              <h1 className="text-foreground text-xl font-medium text-balance">{title}</h1>
              {titleAddon}
            </div>
            <p className="text-muted-foreground text-sm text-balance">{description}</p>
          </div>
          {/* Search and action are ONE right-hand group, search first. As three
              loose children of a `justify-between` row, `action` was pushed to
              the middle of the header — visually detached from both the
              heading it did not belong to and the search it sat next to. */}
          {search || action ? (
            <div className={cn('flex w-full shrink-0 items-center gap-2', !stacked && 'sm:w-auto')}>
              {search ? (
                <div className={cn('min-w-0 flex-1', !stacked && 'sm:w-64 sm:flex-none')}>
                  {search}
                </div>
              ) : null}
              {action}
            </div>
          ) : null}
        </header>
        {filters ? (
          <div className="flex flex-wrap items-center justify-between gap-2">{filters}</div>
        ) : null}
        <CapabilityScrollRootProvider scrollRef={scrollRef}>
          {children}
        </CapabilityScrollRootProvider>
      </div>
    </div>
  );
}
