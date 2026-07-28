'use client';

/**
 * The connectors catalogue grid — the cards, the group headers, the pager.
 *
 * Presentational on purpose: it takes `CatalogueEntry` values and callbacks and
 * owns no queries, so `connectors-catalogue.tsx` can decide what a click means
 * (open a connector you already have vs. add one you don't) and this file can
 * be rendered in a test with plain objects.
 *
 * Reference: ux-references/perplexity/06-connectors-list.png.
 */

import {
  BadgeCheck,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  LayoutGrid,
  MessageSquare,
  Plug,
  Plus,
  Briefcase as SalesIcon,
  TrendingUp,
} from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia } from '@/components/ui/item';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';

import {
  type CatalogueEntry,
  type CatalogueGroup,
  GROUP_PAGE_SIZE,
  pageCount,
  pageSlice,
} from './connector-catalogue';

const GROUP_ICON: Record<string, typeof Plug> = {
  connected: Plug,
  popular: TrendingUp,
  communication: MessageSquare,
  productivity: LayoutGrid,
  development: Code2,
  sales_support: SalesIcon,
  more: Boxes,
};

/** Why a curated group exists at all — stated on the group, not buried in a doc. */
const CURATED_HINT = 'Grouped by Kortix. The app directory has no categories of its own.';

export interface ConnectorCatalogueCardProps {
  entry: CatalogueEntry;
  /** Open an already-added connector. */
  onOpen: (slug: string) => void;
  /** Add an available one. Omitted for read-only members. */
  onAdd?: (entry: CatalogueEntry) => void;
  /** The add in flight, if any. */
  pendingSlug?: string | null;
}

function CatalogueIcon({ entry }: { entry: CatalogueEntry }) {
  if (entry.iconUrl) {
    return (
      <span className="border-border/60 bg-card relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm border">
        <Image
          src={entry.iconUrl}
          alt=""
          fill
          sizes="32px"
          referrerPolicy="no-referrer"
          className="object-contain p-1"
          unoptimized
        />
      </span>
    );
  }
  return <EntityAvatar icon={Plug} size="md" label={entry.name} />;
}

export function ConnectorCatalogueCard({
  entry,
  onOpen,
  onAdd,
  pendingSlug,
}: ConnectorCatalogueCardProps) {
  const pending = pendingSlug === entry.slug;
  const addable = !entry.connected && Boolean(onAdd);
  const label = entry.connected ? `Open ${entry.name}` : `Add ${entry.name}`;

  return (
    <Item
      asChild
      variant="outline"
      size="sm"
      className="bg-popover hover:bg-muted/60 h-full items-start gap-3 text-left transition-colors active:scale-[0.995] disabled:opacity-60"
    >
      <button
        type="button"
        aria-label={label}
        disabled={pending || (!entry.connected && !addable)}
        onClick={() => {
          if (entry.connected) onOpen(entry.slug);
          else onAdd?.(entry);
        }}
      >
        <ItemMedia>
          <CatalogueIcon entry={entry} />
        </ItemMedia>
        <ItemContent className="gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-foreground truncate text-sm leading-snug font-medium">
              {entry.name}
            </span>
            {entry.official ? (
              <>
                <BadgeCheck className="text-muted-foreground/60 size-3.5 shrink-0" aria-hidden />
                <span className="sr-only">One-click app — Kortix runs the sign-in</span>
              </>
            ) : null}
          </span>
          {entry.description ? (
            <ItemDescription className="text-xs">{entry.description}</ItemDescription>
          ) : entry.toolCount !== null && !entry.needsSetup ? (
            // Only claimed for a connector that can actually call them. An
            // unauthorized one can call zero tools until its credential is set.
            <ItemDescription className="text-xs">
              {entry.toolCount} {entry.toolCount === 1 ? 'tool' : 'tools'} this project can call
            </ItemDescription>
          ) : null}
          {entry.failing ? (
            <Badge variant="destructive" size="xs" className="w-fit">
              Error
            </Badge>
          ) : entry.needsSetup ? (
            <Badge variant="warning" size="xs" className="w-fit">
              Needs setup
            </Badge>
          ) : null}
        </ItemContent>
        <ItemActions className="self-start">
          {pending ? (
            <Loading className="size-4 shrink-0" />
          ) : entry.connected ? (
            <Check className="text-kortix-green size-4 shrink-0" aria-hidden />
          ) : addable ? (
            <Plus className="text-muted-foreground/50 size-4 shrink-0" aria-hidden />
          ) : null}
        </ItemActions>
      </button>
    </Item>
  );
}

export interface ConnectorCatalogueGridProps {
  entries: CatalogueEntry[];
  onOpen: (slug: string) => void;
  onAdd?: (entry: CatalogueEntry) => void;
  pendingSlug?: string | null;
  className?: string;
}

/** The flat 3-up grid. Every grouped section renders one of these. */
export function ConnectorCatalogueGrid({
  entries,
  onOpen,
  onAdd,
  pendingSlug,
  className,
}: ConnectorCatalogueGridProps) {
  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {entries.map((entry) => (
        <ConnectorCatalogueCard
          key={entry.slug}
          entry={entry}
          onOpen={onOpen}
          onAdd={onAdd}
          pendingSlug={pendingSlug}
        />
      ))}
    </div>
  );
}

export interface ConnectorCatalogueGroupProps {
  group: CatalogueGroup;
  onOpen: (slug: string) => void;
  onAdd?: (entry: CatalogueEntry) => void;
  pendingSlug?: string | null;
}

export function ConnectorCatalogueGroupSection({
  group,
  onOpen,
  onAdd,
  pendingSlug,
}: ConnectorCatalogueGroupProps) {
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const pages = pageCount(group.entries.length, GROUP_PAGE_SIZE);
  const visible = expanded ? group.entries : pageSlice(group.entries, page, GROUP_PAGE_SIZE);
  const GroupIcon = GROUP_ICON[group.id] ?? Boxes;
  const heading = (
    <h2 className="text-foreground flex items-center gap-1.5 text-sm font-medium">
      <GroupIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      {group.label}
      {/* The tooltip only exists on hover; this keeps the caveat in the page. */}
      {group.curated ? <span className="sr-only">{CURATED_HINT}</span> : null}
    </h2>
  );

  return (
    <section className="space-y-3" aria-label={group.label}>
      <header className="flex items-center justify-between gap-3">
        {group.curated ? (
          <Hint label={CURATED_HINT} side="top">
            <span className="cursor-default">{heading}</span>
          </Hint>
        ) : (
          heading
        )}
        <div className="flex items-center gap-0.5">
          {!expanded && pages > 1 ? (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Previous ${group.label} connectors`}
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`More ${group.label} connectors`}
                disabled={page >= pages - 1}
                onClick={() => setPage((current) => Math.min(pages - 1, current + 1))}
              >
                <ChevronRight className="size-4" />
              </Button>
            </>
          ) : null}
          {group.entries.length > GROUP_PAGE_SIZE ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setExpanded((current) => !current);
                setPage(0);
              }}
            >
              {expanded ? 'Show less' : 'View all'}
            </Button>
          ) : null}
        </div>
      </header>
      <ConnectorCatalogueGrid
        entries={visible}
        onOpen={onOpen}
        onAdd={onAdd}
        pendingSlug={pendingSlug}
      />
    </section>
  );
}

export interface ConnectorCatalogueGroupsProps {
  groups: CatalogueGroup[];
  onOpen: (slug: string) => void;
  onAdd?: (entry: CatalogueEntry) => void;
  pendingSlug?: string | null;
}

export function ConnectorCatalogueGroups({
  groups,
  onOpen,
  onAdd,
  pendingSlug,
}: ConnectorCatalogueGroupsProps) {
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <ConnectorCatalogueGroupSection
          key={group.id}
          group={group}
          onOpen={onOpen}
          onAdd={onAdd}
          pendingSlug={pendingSlug}
        />
      ))}
    </div>
  );
}
