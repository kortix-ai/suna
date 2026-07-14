'use client';

import { ArrowRight, Boxes, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Portal } from '@/components/ui/portal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { Icon } from '@/features/icon/icon';
import { useAuth } from '@/features/providers/auth-provider';
import type { MarketplaceItem, MarketplaceItemDetail, MarketplaceSummary } from '@/lib/marketplace-client';
import { marketplaceItemHref, marketplaceSourceHref } from '@/lib/marketplace-slug';
import { AddToProjectModal } from './add-to-project-modal';
import { MarketplaceAvatar } from './marketplace-avatar';
import { displayCompanyLabel } from './marketplace-company-filter';
import { MarketplaceExploreCard } from './marketplace-explore-card';
import { MarketplaceFileTree } from './marketplace-file-tree';
import { MarketplaceFileView } from './marketplace-file-view';
import { groupMarketplaceItemsByType } from './marketplace-grid';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import {
  emptyDescriptionCopy,
  emptyReadmeCopy,
  groupCapabilities,
  resolveBundleMembers,
  totalCapabilityCount,
} from './marketplace-item-view';
import { TypeTile, typeMeta } from './marketplace-meta';
import { MarketplaceProjectCard } from './marketplace-project-card';
import { projectBannerClass } from './marketplace-project-visual';
import { MarketplaceShell } from './marketplace-shell';
import { useMarketplaceSurface } from './marketplace-surface';

function stripFrontmatter(md: string): string {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3);
    if (end !== -1) {
      const nl = md.indexOf('\n', end + 1);
      return (nl !== -1 ? md.slice(nl + 1) : '').trimStart();
    }
  }
  return md;
}

function SectionLabel({ count, children }: { count?: number; children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground mb-3 flex items-center gap-2 text-sm">
      <span>{children}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground/50 tabular-nums">{count}</span>
      ) : null}
    </div>
  );
}

function RowPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-popover divide-border divide-y overflow-hidden rounded-md border">
      {children}
    </div>
  );
}

/** A bundle/project member — navigates via the surface (route link on public,
 *  detail-store button in the in-project overlay). */
function BundleMemberRow({
  id,
  title,
  type,
  description,
}: {
  id: string;
  title: string;
  type: string | null;
  description?: string | null;
}) {
  const surface = useMarketplaceSurface();
  // Prefer the member's own description; fall back to the type label (e.g. in a
  // flat bundle view where the type isn't already the section header).
  const subtitle = description?.trim() || (type ? typeMeta(type).label : null);
  const body = (
    <>
      {type ? (
        <TypeTile type={type} size="sm" />
      ) : (
        <span className="bg-foreground/5 text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
          <FileText className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm">{title}</span>
        {subtitle ? (
          <span className="text-muted-foreground/70 block truncate text-xs">{subtitle}</span>
        ) : null}
      </span>
    </>
  );
  const rowClass = 'hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors';
  if (surface.variant === 'public') {
    return (
      <Link href={surface.itemHref(id)} className={rowClass}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => surface.openItem(id)} className={rowClass}>
      {body}
    </button>
  );
}

/** The README renders in full (no collapse) — it's the primary content. */
function ReadmeMarkdown({ content }: { content: string }) {
  return (
    <div className="bg-secondary rounded-md border p-4">
      <div className="prose-sm text-foreground/90 max-w-none">
        <UnifiedMarkdown content={content} allowHtml={false} />
      </div>
    </div>
  );
}

/** Line-clamped description with a Show more/less toggle (the rail is narrow). */
function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  const checkOverflow = useCallback(() => {
    const el = ref.current;
    if (!el || expanded) return;
    setCanExpand(el.scrollHeight > el.clientHeight + 1);
  }, [expanded]);

  useLayoutEffect(() => {
    checkOverflow();
  }, [checkOverflow, text]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    window.addEventListener('resize', checkOverflow);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', checkOverflow);
    };
  }, [checkOverflow]);

  return (
    <div className="space-y-1">
      <p
        ref={ref}
        className={cn(
          'text-foreground/90 text-sm leading-relaxed text-pretty',
          !expanded && 'line-clamp-5',
        )}
      >
        {text}
      </p>
      {canExpand ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground text-xs font-medium transition-colors"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/** The primary CTA area — ONE "Add to a project" action (opens
 *  `AddToProjectModal`, which starts an agent-import session) for every item
 *  type on every surface. Public + signed-out gets an auth-redirect button
 *  instead. Adding is always an agent import now, so there's no deterministic
 *  "installed" state to track here and no Remove affordance. */
function ItemActions({ data }: { data: MarketplaceItemDetail }) {
  const surface = useMarketplaceSurface();
  const { user, isLoading: authLoading } = useAuth();

  const [addOpen, setAddOpen] = useState(false);

  const inProject = surface.variant === 'project';

  if (!authLoading && !user && surface.variant === 'public') {
    const redirectHref = surface.itemHref(data.id);
    return (
      <Button variant="default" className="w-full gap-1.5" asChild>
        <Link href={`/auth?redirect=${encodeURIComponent(redirectHref)}`}>
          Sign in to add
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    );
  }

  return (
    <>
      <div className="flex w-full items-center gap-2">
        <Button
          variant="default"
          className="flex-1 gap-1.5"
          disabled={authLoading}
          onClick={() => setAddOpen(true)}
        >
          Add to a project
        </Button>
      </div>
      <AddToProjectModal
        item={data}
        open={addOpen}
        onOpenChange={setAddOpen}
        fixedProjectId={inProject ? surface.projectId : undefined}
      />
    </>
  );
}

/** Identity + actions + metadata — the left rail (page) / top block (overlay). */
function ItemSidebar({
  data,
  company,
  itemTitle,
  fileTargets,
  selectedFile,
  onSelectFile,
}: {
  data: MarketplaceItemDetail;
  company?: MarketplaceSummary;
  itemTitle: string;
  /** Install targets for the Files tree (drives the main-column file view). */
  fileTargets: string[];
  selectedFile: string | undefined;
  onSelectFile: (target: string) => void;
}) {
  const surface = useMarketplaceSurface();
  const tm = typeMeta(data.type);
  const isProject = data.type === 'registry:project';
  const companyLabel = displayCompanyLabel(data.marketplaceId, data.marketplaceLabel);
  const sourceUrl = company?.sourceUrl ?? data.sourceUrl;
  const companyClickable = surface.variant === 'public';

  return (
    <>
      <div className="space-y-4">
        {isProject ? (
          <div
            className={cn(
              'flex h-20 items-center justify-center rounded-md bg-gradient-to-br',
              projectBannerClass(data.name || data.id),
            )}
          >
            <Boxes className="text-foreground/60 size-7" aria-hidden />
          </div>
        ) : (
          <MarketplaceItemAvatar item={data} size="lg" showSource={false} />
        )}

        <div className="space-y-1">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance capitalize">
            {itemTitle}
          </h1>
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <tm.Icon className="size-3.5 shrink-0" />
            {tm.label}
          </span>
        </div>

        <ExpandableText text={data.description || emptyDescriptionCopy(data.type)} />

        <div className="flex flex-col items-start gap-2">
          <ItemActions data={data} />
          {sourceUrl ? (
            <Link
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
            >
              <Icon.Github className="size-3.5" />
              View source
            </Link>
          ) : null}
        </div>
      </div>

      {data.partOfProject ? (
        <div>
          <SectionLabel>Part of a project</SectionLabel>
          {surface.variant === 'public' ? (
            <Link
              href={marketplaceItemHref(data.partOfProject.id)}
              className="group bg-popover hover:bg-muted/50 flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors"
            >
              <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
                <Boxes className="size-4" />
              </span>
              <span className="text-foreground truncate text-sm font-medium group-hover:underline">
                {data.partOfProject.title}
              </span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => surface.openItem(data.partOfProject!.id)}
              className="group bg-popover hover:bg-muted/50 flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors"
            >
              <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
                <Boxes className="size-4" />
              </span>
              <span className="text-foreground truncate text-sm font-medium group-hover:underline">
                {data.partOfProject.title}
              </span>
            </button>
          )}
        </div>
      ) : null}

      {fileTargets.length > 0 ? (
        <div>
          <SectionLabel count={fileTargets.length}>Files</SectionLabel>
          <div className="bg-popover max-h-72 overflow-y-auto rounded-md border py-1">
            <MarketplaceFileTree
              targets={fileTargets}
              selected={selectedFile}
              onSelect={onSelectFile}
            />
          </div>
        </div>
      ) : null}

      {companyClickable ? (
        <Link
          href={marketplaceSourceHref(data.marketplaceId)}
          className="group border-border/60 flex items-center gap-3 border-t pt-4 transition-transform active:scale-[0.98]"
        >
          <MarketplaceAvatar
            id={data.marketplaceId}
            owner={company?.owner ?? data.owner}
            sourceUrl={sourceUrl}
            label={data.marketplaceLabel}
            size="md"
          />
          <div className="min-w-0">
            <div className="text-foreground truncate text-sm font-medium group-hover:underline">
              {companyLabel}
            </div>
            {company?.count !== undefined ? (
              <div className="text-muted-foreground text-xs tabular-nums">
                {company.count} {company.count === 1 ? 'item' : 'items'}
              </div>
            ) : null}
          </div>
        </Link>
      ) : (
        <div className="border-border/60 flex items-center gap-3 border-t pt-4">
          <MarketplaceAvatar
            id={data.marketplaceId}
            owner={company?.owner ?? data.owner}
            sourceUrl={sourceUrl}
            label={data.marketplaceLabel}
            size="md"
          />
          <div className="text-foreground truncate text-sm font-medium">{companyLabel}</div>
        </div>
      )}
    </>
  );
}

export interface DetailNav {
  /** 1-based position in the surrounding list. */
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
}

/**
 * Derives the `DetailPager` nav from a sibling id list + the currently open
 * id — 1-based position, and prev/next callbacks clamped at the ends.
 * Shared by the public detail page (`MarketplaceDetailPublic`, which routes
 * between item pages) and the in-project overlay (`MarketplaceView`, which
 * drives the detail store instead) — they differ only in what `goTo` does.
 */
export function useDetailNav(
  ids: string[],
  currentId: string | undefined,
  goTo: (id: string) => void,
): DetailNav | undefined {
  const idx = currentId ? ids.indexOf(currentId) : -1;
  if (ids.length === 0 || idx < 0) return undefined;
  const prevId = idx > 0 ? ids[idx - 1] : undefined;
  const nextId = idx < ids.length - 1 ? ids[idx + 1] : undefined;
  return {
    index: idx + 1,
    total: ids.length,
    onPrev: prevId ? () => goTo(prevId) : undefined,
    onNext: nextId ? () => goTo(nextId) : undefined,
  };
}

/**
 * A floating pager over the item list — prev/next + "position / total",
 * hovering at the bottom-center of the screen like a lightbox control (so it
 * isn't tucked into the sidebar). ← / → drive the same actions.
 *
 * Portaled to the dedicated portal root (outside any transformed ancestor) so
 * `fixed` resolves against the viewport even when this renders inside the
 * Customize panel's `ModalContent` (a CSS-`transform`ed box would otherwise
 * turn `fixed` into `absolute`-like containment). The z-index comes from the
 * shared z-stack helper (not a bare Tailwind class) so it floats above
 * whatever dialog depth it's nested in instead of a fixed `z-40`.
 */
function DetailPager({ nav }: { nav: DetailNav }) {
  const depth = useDialogDepth();
  return (
    <Portal>
      <div
        className="bg-background/85 fixed bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full border p-1 shadow-lg backdrop-blur-sm"
        style={{ zIndex: floatingZ(depth) }}
      >
        <button
          type="button"
          onClick={nav.onPrev}
          disabled={!nav.onPrev}
          aria-label="Previous item"
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-8 items-center justify-center rounded-full transition disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-foreground min-w-[3.75rem] px-1 text-center text-xs font-medium tabular-nums">
          {nav.index} <span className="text-muted-foreground/50">/</span> {nav.total}
        </span>
        <button
          type="button"
          onClick={nav.onNext}
          disabled={!nav.onNext}
          aria-label="Next item"
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-8 items-center justify-center rounded-full transition disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </Portal>
  );
}

/**
 * The one marketplace item detail — used both as the public SSR page and as
 * the in-project Customize overlay. Variant + navigation come from
 * `useMarketplaceSurface`; `onBack` (present in the overlay) turns the first
 * breadcrumb into an in-panel back button.
 */
export function MarketplaceDetail({
  data,
  company,
  otherProjects = [],
  onBack,
  nav,
}: {
  data: MarketplaceItemDetail;
  company?: MarketplaceSummary;
  /** Other `registry:project` items, for cross-link discovery (public only). */
  otherProjects?: MarketplaceItem[];
  /** In-project overlay: renders an embedded shell + a back-button crumb. */
  onBack?: () => void;
  /** Floating pager over the surrounding item list (← / → + position). */
  nav?: DetailNav;
}) {
  const onPrev = nav?.onPrev;
  const onNext = nav?.onNext;
  // ← / → step through the surrounding item list (ignored while typing).
  useEffect(() => {
    if (!onPrev && !onNext) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft' && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPrev, onNext]);

  const capGroups = groupCapabilities(data.capabilities);
  const capCount = totalCapabilityCount(data.capabilities);
  const isProject = data.type === 'registry:project';
  const isBundle = data.type === 'registry:bundle' || isProject;
  const bundleMembers = isBundle
    ? resolveBundleMembers({
        dependencies: data.dependencies,
        dependencyItems: data.dependencyItems,
        hrefForId: (id) => id,
      })
    : [];
  // A project shows its README first, then its contents rendered as the SAME
  // marketplace cards, in the SAME typed grid, as the main gallery — so a skill
  // inside the project looks exactly like a skill listed on the marketplace.
  // Each content item is a full catalog id, so we synthesize a MarketplaceItem
  // from the resolved dependency metadata + the project's own source identity.
  const memberItemGroups = useMemo(() => {
    if (!isProject) return [];
    const byName = new Map(data.dependencyItems.map((d) => [d.name, d]));
    const items: MarketplaceItem[] = data.dependencies
      .map((name) => byName.get(name))
      .filter((d): d is MarketplaceItemDetail['dependencyItems'][number] => Boolean(d))
      .map((d) => ({
        id: d.id,
        registry: data.registry,
        name: d.name,
        type: d.type,
        title: d.title,
        description: d.description,
        categories: [],
        capabilities: { secrets: [], connectors: [], tools: [], network: [] },
        dependencies: [],
        fileCount: 0,
        external: data.external,
        marketplaceId: data.marketplaceId,
        marketplaceLabel: data.marketplaceLabel,
        owner: data.owner,
        sourceUrl: data.sourceUrl,
      }));
    return groupMarketplaceItemsByType(items);
  }, [isProject, data]);
  const readme = data.readme ? stripFrontmatter(data.readme) : '';
  const itemTitle = data.title.replaceAll('-', ' ');
  const companyLabel = displayCompanyLabel(data.marketplaceId, data.marketplaceLabel);

  // The sidebar Files tree selects which file the main column shows; it defaults
  // to the README/SKILL.md (whose already-SSR'd body the view reuses).
  const fileTargets = data.files.map((f) => f.target);
  const readmeTarget =
    fileTargets.find((t) => /README\.md$/i.test(t)) ??
    fileTargets.find((t) => /SKILL\.md$/i.test(t)) ??
    fileTargets[0];
  const [selectedFile, setSelectedFile] = useState<string | undefined>(readmeTarget);
  // Reset to the default doc when the item changes (the overlay reuses this mount).
  useEffect(() => {
    setSelectedFile(readmeTarget);
  }, [readmeTarget]);

  // A skill that ships inside a project gets that project as a breadcrumb level:
  // Marketplace / <source> / <Project> / <item>.
  const projectCrumb = data.partOfProject
    ? { label: data.partOfProject.title, href: marketplaceItemHref(data.partOfProject.id) }
    : null;
  const crumbs = onBack
    ? [
        { label: 'Marketplace', onClick: onBack },
        ...(projectCrumb ? [projectCrumb] : []),
        { label: itemTitle },
      ]
    : [
        { label: 'Marketplace', href: '/marketplace' },
        { label: companyLabel, href: marketplaceSourceHref(data.marketplaceId) },
        ...(projectCrumb ? [projectCrumb] : []),
        { label: itemTitle },
      ];

  const filesSection =
    data.files.length > 0 ? (
      <section className="space-y-3">
        <MarketplaceFileView
          itemId={data.id}
          selected={selectedFile}
          readmeTarget={readmeTarget}
          readme={readme || null}
        />
      </section>
    ) : readme ? (
      <section className="space-y-3">
        <ReadmeMarkdown content={readme} />
      </section>
    ) : (
      <section className="space-y-3">
        <EmptyState
          icon={FileText}
          size="sm"
          title="No files"
          description={emptyReadmeCopy(data.type)}
        />
      </section>
    );

  // Non-project bundles keep the flat "What's inside" row list; a project renders
  // its contents as marketplace cards (memberItemGroups) below its README.
  const membersSection =
    !isProject && isBundle && bundleMembers.length > 0 ? (
      <section>
        <SectionLabel count={bundleMembers.length}>What&rsquo;s inside</SectionLabel>
        <RowPanel>
          {bundleMembers.map((member) => (
            <BundleMemberRow
              key={member.key}
              id={member.key}
              title={member.title}
              type={member.type}
              description={member.description}
            />
          ))}
        </RowPanel>
      </section>
    ) : null;

  return (
    <>
      {nav ? <DetailPager nav={nav} /> : null}
      <MarketplaceShell
        embedded={!!onBack}
        crumbs={crumbs}
        sidebar={
          <ItemSidebar
            data={data}
            company={company}
            itemTitle={itemTitle}
            fileTargets={fileTargets}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
          />
        }
      >
      <div className="space-y-8">
        {isProject ? (
          <>
            {/* README first — the file view defaults to the project's README.md
                (the sidebar file tree drives it to browse any other file). */}
            {filesSection}
            {/* Then the contents, as the SAME cards + typed grid as the gallery. */}
            {memberItemGroups.map((g) => (
              <section key={g.label}>
                <SectionLabel count={g.items.length}>{g.label}</SectionLabel>
                <div className="grid gap-3 sm:grid-cols-3">
                  {g.items.map((it) => (
                    <MarketplaceExploreCard key={it.id} item={it} showSource={false} />
                  ))}
                </div>
              </section>
            ))}
          </>
        ) : (
          <>
            {filesSection}
            {membersSection}
          </>
        )}

        {capCount > 0 ? (
          <section>
            <SectionLabel count={capCount}>Requires</SectionLabel>
            <div className="bg-popover space-y-3 rounded-md border px-4 py-4">
              {capGroups.map((group) => (
                <div key={group.kind}>
                  <div className="text-muted-foreground mb-1.5 text-xs">{group.label}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.items.map((value) => (
                      <Badge
                        key={`${group.kind}:${value}`}
                        variant="outline"
                        size="sm"
                        className="font-mono"
                      >
                        {value}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {isProject && otherProjects.length > 0 ? (
          <section>
            <SectionLabel count={otherProjects.length}>Other projects</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              {otherProjects.map((project) => (
                <MarketplaceProjectCard key={project.id} item={project} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
      </MarketplaceShell>
    </>
  );
}
