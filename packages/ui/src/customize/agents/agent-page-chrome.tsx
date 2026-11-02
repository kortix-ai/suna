'use client';

/**
 * The agent page's frame: one identity header, one row of tabs under it, and
 * the content below, all on one left edge. A tab with several views
 * (Capabilities, Access) lists them in a rail left of its content.
 *
 *   ┌ ▣ researcher                         [Share] [Start session] [⋯] ┐
 *   │   ● Enabled · Space: workspace · People start it                 │
 *   │ Overview  Model  Capabilities  Access  Workspace  Triggers 1     │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ Tools   All but 2 │ content (the one scroller)                   │
 *   │ Skills     4 of 9 │   (a tab with several views: the rail;      │
 *   │ …                 │    below `md`, a row of pills instead)       │
 *   └──────────────────────── [ ● Unsaved changes  Skills  Discard  Save ⌘S ]
 *
 * The header echoes the Space channel header (`space-page.tsx`): a tile, the
 * name at `text-xl font-medium`, one muted line. It is also the window's
 * title-bar row (`kx-titlebar-row`), so it holds the sidebar opener and the
 * desktop drag band: the page adds no bar for either.
 */

import { type MouseEvent, type ReactNode, useCallback } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { useInCustomizeFrame } from '../shared/customize-tab-bar';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../primitives/alert-dialog';
import { Kbd } from '../../primitives/kbd';
import { useOptionalSidebar } from '../../primitives/sidebar';
import { Skeleton } from '../../primitives/skeleton';
import { StatusDot, type StatusTone } from '../../primitives/status';
import { UiLink as Link, useUiShallowNavigate } from '../../providers/ui-provider';
import { m, useReducedMotion } from 'motion/react';

import { FadedScrollArea } from '../../primitives/faded-scroll-area';

import type { AgentRailKey } from './agent-tabs';

/** One fact on the header's meta line. A `tone` draws the status dot first. */
export interface HeaderFact {
  label: ReactNode;
  tone?: StatusTone;
}

/**
 * The one header of every Customize page: the agent page, My Kortix, the
 * Agents index, Review and the error / not-found states. Same top offset, same
 * title rung, same height, so moving between them never makes the title jump.
 * `slug` draws the agent's mark; a page that is not one agent has no tile.
 * `rule` draws the bottom hairline; the agent page leaves it to its tab row.
 * It is the window's title-bar row (`kx-titlebar-row`), so it holds the
 * sidebar opener and the desktop drag band.
 */
export function CustomizeHeader({
  slug,
  title,
  facts,
  description,
  actions,
  rule = false,
}: {
  slug?: string;
  title: ReactNode;
  facts?: HeaderFact[];
  /** One muted line under the title, for a page with no facts. */
  description?: ReactNode;
  actions?: ReactNode;
  rule?: boolean;
}) {
  const sidebar = useOptionalSidebar();
  // Under the Customize bar, the bar is the title-bar row and holds the opener.
  const framed = useInCustomizeFrame();
  return (
    <header
      className={cn(
        // The Customize tab bar's height and inset: a 48px row, 16px sides.
        'flex min-h-12 shrink-0 items-center gap-3 px-4 py-2',
        !framed && 'kx-titlebar-row',
        rule && 'border-b',
      )}
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      {framed ? null : <SidebarToggle />}
      {slug ? <AgentMark slug={slug} size={21} /> : null}
      <div className="min-w-0 flex-1">
        <h1 className="text-foreground truncate text-base font-medium">{title}</h1>
        {description && !(facts && facts.length > 0) ? (
          <p className="text-muted-foreground truncate text-sm">{description}</p>
        ) : null}
        {facts && facts.length > 0 ? (
          <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 truncate text-sm">
            {facts.map((fact, index) => (
              <span key={index} className="flex min-w-0 shrink-0 items-center gap-1.5 last:shrink">
                {index > 0 ? <span aria-hidden>·</span> : null}
                {fact.tone ? <StatusDot tone={fact.tone} /> : null}
                <span className="truncate">{fact.label}</span>
              </span>
            ))}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** The agent page's name for the header. */
export const AgentIdentityHeader = CustomizeHeader;

export interface AgentRailItem {
  key: AgentRailKey;
  label: string;
  href: string;
  count?: number | string;
}

/** One top tab of the agent page: one view, or several shown as pills. */
export interface AgentTabGroup {
  key: string;
  label: string;
  items: AgentRailItem[];
}

/**
 * The agent page's navigation: one row of tabs under the header, and, when the
 * active tab holds several views, one row of pills for them. Every
 * `agents.<name>` key in kortix.yaml lives on exactly one tab or pill
 * (`YAML_KEY_ROW`). A tab or pill holding an unsaved edit carries a dot. The
 * row scrolls sideways on a narrow window instead of wrapping.
 */
export function AgentTabBar({
  groups,
  active,
  dirty,
}: {
  groups: AgentTabGroup[];
  active: AgentRailKey;
  dirty?: readonly AgentRailKey[];
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const go = useInPageNavigate();
  const shown = groups.filter((group) => group.items.length > 0);
  const current = shown.find((group) => group.items.some((item) => item.key === active)) ?? shown[0];
  const dot = <span role="img" aria-label={t('unsavedTab')} className="bg-foreground size-1.5 shrink-0 rounded-full" />;
  return (
    <>
      <nav aria-label={t('tabsLabel')} className="shrink-0 border-b">
        <FadedScrollArea orientation="horizontal" fadeColor="from-background">
          <div className="flex w-max items-center gap-1 px-2">
            {shown.map((group) => {
              const on = group === current;
              const single = group.items.length === 1 ? group.items[0] : null;
              return (
                <Link
                  key={group.key}
                  href={group.items[0].href}
                  prefetch={false}
                  onClick={(e) => go(e, group.items[0].href)}
                  aria-current={on ? 'page' : undefined}
                  data-testid={`agent-tab-${group.key}`}
                  className={cn(
                    '-mb-px flex h-10 items-center gap-1.5 border-b-2 px-2 text-sm whitespace-nowrap transition-colors',
                    on ? 'border-foreground text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent',
                  )}
                >
                  {group.label}
                  {group.items.some((item) => dirty?.includes(item.key)) ? dot : null}
                  {single && single.key === 'triggers' && single.count !== undefined ? (
                    <span className="text-muted-foreground tabular-nums">{single.count}</span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </FadedScrollArea>
      </nav>
      {current && current.items.length > 1 ? (
        // Below `md` only: wider, the content's rail (`agent-section-rail.tsx`) lists the views.
        <div className="shrink-0 md:hidden">
          <FadedScrollArea orientation="horizontal" fadeColor="from-background">
            <div className="flex w-max items-center gap-1 px-2 pt-4">
              {current.items.map((item) => {
                const on = item.key === active;
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    prefetch={false}
                    onClick={(e) => go(e, item.href)}
                    aria-current={on ? 'page' : undefined}
                    data-testid={`agent-view-${item.key}`}
                    className={cn(
                      'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap transition-colors',
                      on ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                    )}
                  >
                    {item.label}
                    {dirty?.includes(item.key) ? dot : null}
                    {item.count !== undefined ? <span className="text-muted-foreground tabular-nums">{item.count}</span> : null}
                  </Link>
                );
              })}
            </div>
          </FadedScrollArea>
        </div>
      ) : null}
    </>
  );
}

/**
 * A tab, view or rail link on the agent page only changes the query
 * (`?tab=&view=`): the page and its draft stay mounted. A plain click writes
 * the URL to history (`useUiShallowNavigate`) instead of a router navigation,
 * which in Next.js waits on a server round trip for the same route. A
 * modified or middle click keeps the link's own behavior (a new tab).
 */
export function useInPageNavigate(): (event: MouseEvent<HTMLAnchorElement>, href: string) => void {
  const navigate = useUiShallowNavigate();
  return useCallback(
    (event, href) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(href);
    },
    [navigate],
  );
}

/** The scroller under the tabs, on the page gutter. */
export function AgentTabBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn('w-full px-4 pt-5 pb-24 md:px-8', className)}>{children}</div>
    </div>
  );
}

/**
 * The page before its reads land: the header, the tab row, and the Overview's
 * centered column as three grouped blocks (description, instructions,
 * properties). Grouped on purpose: a line per field reads as noise.
 */
export function AgentPageSkeleton() {
  const sidebar = useOptionalSidebar();
  const framed = useInCustomizeFrame();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" aria-busy>
      <header
        className={cn('flex min-h-12 shrink-0 items-center gap-3 px-4 py-2', !framed && 'kx-titlebar-row')}
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        {framed ? null : <SidebarToggle />}
        {/* The mark tile's literal 28px (`agent-mark.tsx` TILE[21]). */}
        <Skeleton className="shrink-0 rounded-md py-0" style={{ width: 28, height: 28 }} />
        <Skeleton className="h-4 w-40 rounded-sm py-0" />
      </header>
      <div className="flex h-10 shrink-0 items-center gap-4 border-b px-4" aria-hidden>
        <Skeleton className="h-3.5 w-16 rounded-sm py-0" />
        <Skeleton className="h-3.5 w-16 rounded-sm py-0" />
        <Skeleton className="h-3.5 w-16 rounded-sm py-0" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-4 pt-5 md:px-8" aria-hidden>
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <Skeleton className="h-20 w-full rounded-md py-0" />
          <Skeleton className="h-80 w-full rounded-lg py-0" />
          <Skeleton className="h-48 w-full rounded-md py-0" />
        </div>
      </div>
    </div>
  );
}

/**
 * A page that has a header and a single state under it (error, not found):
 * the same header slot, so the sidebar opener is always reachable. No tile:
 * the page is not (yet) an agent.
 */
export function AgentStatePage({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <CustomizeHeader title={title} rule />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-4 py-16">{children}</div>
      </div>
    </div>
  );
}

/**
 * The unsaved-edits bar, in the shape of the select-mode bar every list uses
 * (`SelectionBar`, the Triggers bulk bar): one popover card, the state on the
 * left with the changed tabs muted after it, then one secondary ButtonGroup of
 * text buttons (Discard, Save ⌘S). It rises in like that bar and leaves at
 * once. While the save runs, the session dot matrix leads and both disable.
 */
export function SaveBar({
  dirty,
  pending,
  changed,
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  pending: boolean;
  /** The changed tabs, already joined for reading ("Overview and Access"). */
  changed: string;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const reduceMotion = useReducedMotion();
  if (!dirty) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <m.div
        initial={{ opacity: 0, transform: reduceMotion ? 'translateY(0px)' : 'translateY(8px)' }}
        animate={{ opacity: 1, transform: 'translateY(0px)', transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } }}
        className="bg-popover text-popover-foreground border-border pointer-events-auto flex w-full items-center gap-3 rounded-lg border p-2 pl-3.5 shadow-md md:w-auto md:min-w-md md:max-w-full"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium" aria-live="polite">
          {pending ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
          <span className="shrink-0">{tI18nComplete.raw('textefa5855ff509')}</span>
          <span className="text-muted-foreground min-w-0 truncate font-normal">{changed}</span>
        </span>
        <ButtonGroup className="shrink-0">
          <Button type="button" variant="secondary" size="sm" className="h-8 shrink-0" onClick={onDiscard} disabled={pending}>
            {tI18nComplete.raw('texteb1a70e39274')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 shrink-0 gap-1.5"
            onClick={onSave}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {tI18nComplete.raw('text1509f561f241')}
            <Kbd>{tI18nComplete.raw('text8cd003e6301b')}</Kbd>
          </Button>
        </ButtonGroup>
      </m.div>
    </div>
  );
}

/**
 * Asked when a link would leave the page with unsaved edits. Three answers:
 * stay, leave and lose the edits, or save first and then leave.
 */
export function LeaveDialog({
  open,
  changed,
  pending,
  onStay,
  onLeave,
  onSaveAndLeave,
}: {
  open: boolean;
  changed: string;
  pending: boolean;
  onStay: () => void;
  onLeave: () => void;
  onSaveAndLeave: () => void;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onStay())}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('leaveTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('leaveBody', { tabs: changed })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('stay')}</AlertDialogCancel>
          <Button variant="secondary" size="sm" onClick={onLeave} disabled={pending}>
            {t('leave')}
          </Button>
          <Button size="sm" onClick={onSaveAndLeave} disabled={pending} aria-busy={pending || undefined}>
            {t('saveAndLeave')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The agent's display name, for header titles. */
export function agentTitle(slug: string): string {
  return agentDisplayName(slug);
}
