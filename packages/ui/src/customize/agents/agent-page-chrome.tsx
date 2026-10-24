'use client';

/**
 * The agent page's frame: one identity header, one row of underline tabs,
 * then the content. No breadcrumb, no second bar, no rail.
 *
 *   ┌ ▣ researcher                         [Share] [Start session] [⋯] ┐
 *   │   ● Enabled · Space: workspace · People start it                 │
 *   ├ Overview  Instructions •  Access  Runtime  Triggers 1  People 3  ┤
 *   │ content (the one scroller)                                       │
 *   └──────────────── [ ● Unsaved changes  Instructions  Discard  Save ⌘S ]
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

import type { AgentTab } from './agent-tabs';

/** One fact on the header's meta line. A `tone` draws the status dot first. */
export interface HeaderFact {
  label: ReactNode;
  tone?: StatusTone;
}

/**
 * The identity header. `slug` draws the agent's mark; without one (an agent
 * that failed to load or does not exist) the tile is a quiet placeholder, so
 * every state of the page keeps the same header slot.
 */
export function AgentIdentityHeader({
  slug,
  title,
  facts,
  actions,
}: {
  slug?: string;
  title: ReactNode;
  facts?: HeaderFact[];
  actions?: ReactNode;
}) {
  const sidebar = useOptionalSidebar();
  return (
    <header
      className="kx-titlebar-row flex shrink-0 items-center gap-3 px-4 pt-4 pb-3 md:px-8"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      {slug ? (
        <AgentMark slug={slug} size={28} />
      ) : (
        <span aria-hidden className="bg-muted size-10 shrink-0 rounded-md" />
      )}
      <div className="min-w-0 flex-1">
        <h1 className="text-foreground truncate text-xl font-medium">{title}</h1>
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

export interface AgentTabItem {
  key: AgentTab;
  label: string;
  href: string;
  count?: number | string;
}

/**
 * The underline tabs under the header. A tab holding an unsaved edit carries a
 * dot, so the save bar's "what changed" is visible from every tab. The row
 * sits above the page's scroller, so it never scrolls away.
 */
export function AgentTabBar({
  items,
  active,
  dirty = [],
}: {
  items: AgentTabItem[];
  active: AgentTab;
  dirty?: readonly AgentTab[];
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  return (
    <Tabs value={active} className="shrink-0 gap-0">
      <TabsList
        type="underline"
        aria-label={t('tabsLabel')}
        className="w-full shrink-0 justify-start gap-1 overflow-x-auto px-4 [scrollbar-width:none] md:px-8"
      >
        {items.map((item) => (
          <TabsTrigger key={item.key} value={item.key} asChild className="w-fit flex-none">
            <Link href={item.href} prefetch={false}>
              {item.label}
              {item.count !== undefined ? (
                <span className="text-muted-foreground tabular-nums">{item.count}</span>
              ) : null}
              {dirty.includes(item.key) ? (
                <span aria-label={t('unsavedTab')} className="bg-foreground size-1.5 rounded-full" />
              ) : null}
            </Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
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
 * The page before its reads land: the header, the six tabs and the Overview's
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
      <div className="flex shrink-0 gap-5 overflow-hidden border-b px-4 pt-1 pb-3 md:px-8">
        {['w-16', 'w-20', 'w-12', 'w-16', 'w-16', 'w-12'].map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
          <Skeleton key={i} className={cn('h-4 shrink-0 rounded-sm', w)} />
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
  );
}

/**
 * A page that has a header and a single state under it (error, not found):
 * the same header slot, so the sidebar opener is always reachable.
 */
export function AgentStatePage({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <AgentIdentityHeader title={title} />
      <div className="min-h-0 flex-1 overflow-y-auto border-t">
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
  /** The changed tabs, already joined for reading ("Instructions and Access"). */
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
