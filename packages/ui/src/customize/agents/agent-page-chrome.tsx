'use client';

/**
 * The agent page's frame: one identity header, then one rail beside the
 * content. No breadcrumb, no second bar.
 *
 *   ┌ ▣ researcher                         [Share] [Start session] [⋯] ┐
 *   │   ● Enabled · Space: workspace · People start it                 │
 *   ├──────────────┬───────────────────────────────────────────────────┤
 *   │ Overview     │ content (the one scroller)                        │
 *   │ Triggers   1 │                                                   │
 *   │ Access       │                                                   │
 *   │  Connectors None                                                 │
 *   │  Skills  All │                                                   │
 *   │ Runtime      │                                                   │
 *   │  Model       │                                                   │
 *   └──────────────┴───── [ ● Unsaved changes  Skills  Discard  Save ⌘S ]
 *
 * The header echoes the Space channel header (`space-page.tsx`): a tile, the
 * name at `text-xl font-medium`, one muted line. It is also the window's
 * title-bar row (`kx-titlebar-row`), so it holds the sidebar opener and the
 * desktop drag band: the page adds no bar for either.
 */

import { type ReactNode } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { SidebarToggle } from '../../internal/layout/sidebar-toggle';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
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
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { UiLink as Link } from '../../providers/ui-provider';
import { AnimatePresence, m } from 'motion/react';

import { RAIL_HORIZONTAL_ROW_CLASS, RAIL_ROW_CLASS, RailGroup } from '../../internal/components/nav-rail';
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
  return (
    <header
      className={cn(
        'kx-titlebar-row flex shrink-0 items-center gap-3 px-4 pt-4 pb-3 md:px-8',
        rule && 'border-b',
      )}
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      {slug ? <AgentMark slug={slug} size={28} /> : null}
      <div className="min-w-0 flex-1">
        <h1 className="text-foreground truncate text-xl font-medium">{title}</h1>
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
  /** The rail group under which the row sits; none for Overview and Triggers. */
  group?: 'access' | 'runtime';
}

/**
 * The agent page's one navigation: every tab and every Access and Runtime
 * view in a single list, so a grant is one click away and its state (All,
 * None, a count) reads on the row. From `md` it is the left rail in Project
 * admin's dialect (`nav-rail.tsx`); below `md` the same rows run as one
 * horizontal strip. A row holding an unsaved edit carries a dot.
 */
export function AgentRail({
  items,
  active,
  dirty,
  groupLabels,
}: {
  items: AgentRailItem[];
  active: AgentRailKey;
  dirty?: readonly AgentRailKey[];
  groupLabels: Record<'access' | 'runtime', string>;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const row = (item: AgentRailItem, horizontal: boolean) => (
    <TabsTrigger
      key={item.key}
      value={item.key}
      asChild
      size={horizontal ? undefined : 'md'}
      className={horizontal ? RAIL_HORIZONTAL_ROW_CLASS : RAIL_ROW_CLASS}
    >
      <Link href={item.href} prefetch={false}>
        <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
        {dirty?.includes(item.key) ? (
          <span role="img" aria-label={t('unsavedTab')} className="bg-foreground size-1.5 shrink-0 rounded-full" />
        ) : null}
        {item.count !== undefined ? (
          <span className={cn('text-muted-foreground font-normal tabular-nums', !horizontal && 'ml-auto')}>
            {item.count}
          </span>
        ) : null}
      </Link>
    </TabsTrigger>
  );
  const groups: { label?: string; rows: AgentRailItem[] }[] = [
    { rows: items.filter((item) => !item.group) },
    { label: groupLabels.access, rows: items.filter((item) => item.group === 'access') },
    { label: groupLabels.runtime, rows: items.filter((item) => item.group === 'runtime') },
  ].filter((group) => group.rows.length > 0);
  return (
    <>
      <nav aria-label={t('tabsLabel')} className="shrink-0 border-b md:hidden">
        <FadedScrollArea orientation="horizontal" fadeColor="from-background" className="py-2">
          <Tabs value={active} className="w-fit px-4">
            <TabsList orientation="horizontal" className="w-fit">
              {groups.flatMap((group) => group.rows).map((item) => row(item, true))}
            </TabsList>
          </Tabs>
        </FadedScrollArea>
      </nav>
      <aside className="hidden w-56 shrink-0 flex-col border-r md:flex">
        <nav
          aria-label={t('tabsLabel')}
          className="flex min-h-0 flex-1 [scrollbar-width:none] flex-col overflow-y-auto px-2 pt-3 pb-24"
        >
          <Tabs value={active} orientation="vertical" className="gap-3">
            {groups.map((group, index) => (
              <RailGroup key={group.label ?? index} label={group.label}>
                {group.rows.map((item) => row(item, false))}
              </RailGroup>
            ))}
          </Tabs>
        </nav>
      </aside>
    </>
  );
}

/** The scroller beside the rail, on the page gutter. */
export function AgentTabBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn('w-full px-4 pt-5 pb-24 md:px-8', className)}>{children}</div>
    </div>
  );
}

/**
 * The page before its reads land: the header, the rail and the Overview's
 * two columns, in the boxes the loaded page draws, so nothing moves.
 */
export function AgentPageSkeleton() {
  const sidebar = useOptionalSidebar();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" aria-busy>
      <header
        className="kx-titlebar-row flex shrink-0 items-center gap-3 px-4 pt-4 pb-3 md:px-8"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <SidebarToggle />
        <Skeleton className="size-10 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-5 w-36 rounded-sm" />
          <Skeleton className="h-3.5 w-64 max-w-full rounded-sm" />
        </div>
        <Skeleton className="hidden h-8 w-48 shrink-0 rounded-md sm:block" />
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden border-t">
        <div className="hidden w-56 shrink-0 space-y-1 border-r px-2 pt-3 md:block" aria-hidden>
          {['w-16', 'w-14', 'w-12', 'w-20', 'w-16', 'w-12', 'w-12', 'w-20', 'w-14'].map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
            <div key={i} className="flex h-8 items-center px-2.5">
              <Skeleton className={cn('h-3.5 rounded-sm', w)} />
            </div>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 gap-8 overflow-hidden px-4 pt-5 md:px-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-6">
            <Skeleton className="h-4 w-3/4 rounded-sm" />
            <Skeleton className="h-40 w-full rounded-md" />
            <div className="divide-border divide-y rounded-md border">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-6 rounded-sm" />
                  <Skeleton className="h-4 w-40 rounded-sm" />
                </div>
              ))}
            </div>
          </div>
          <div className="hidden space-y-3 lg:block">
            <Skeleton className="h-48 w-full rounded-md" />
            <Skeleton className="h-28 w-full rounded-md" />
          </div>
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
 * The save bar: only while the draft differs from what is saved. It names the
 * tabs that hold the edits. Centred over the content, full width under `md`.
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
  return (
    <AnimatePresence initial={false}>
      {dirty ? (
        <m.div
          key="save-bar"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
          className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4"
        >
          <div className="bg-popover text-popover-foreground border-border pointer-events-auto flex w-full items-center gap-3 rounded-lg border p-2 pl-3.5 shadow-lg md:w-auto md:max-w-full">
            <div className="flex min-w-0 flex-1 items-center gap-2" aria-live="polite">
              <span aria-hidden className="bg-foreground size-1.5 shrink-0 rounded-full" />
              <span className="text-foreground shrink-0 text-sm font-medium">
                {tI18nComplete.raw('textefa5855ff509')}
              </span>
              <span className="text-muted-foreground min-w-0 truncate text-sm">{changed}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onDiscard} disabled={pending}>
                {tI18nComplete.raw('texteb1a70e39274')}
              </Button>
              <Button size="sm" className="gap-1.5" onClick={onSave} disabled={pending} aria-busy={pending || undefined}>
                {tI18nComplete.raw('text1509f561f241')}
                <Kbd>{tI18nComplete.raw('text8cd003e6301b')}</Kbd>
              </Button>
            </div>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>
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
