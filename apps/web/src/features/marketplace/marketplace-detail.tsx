'use client';

import { useTranslations } from '@/i18n/use-translations';
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  ArrowUpRightIcon as ArrowUpRight,
  CubeIcon as Boxes,
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  FileTextIcon as FileText,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { FileTree, FileTreeNav } from '@/components/ui/file-tree';
import { Portal } from '@/components/ui/portal';
import { Copy } from '@/features/icon/icons/copy';
import { Github } from '@/features/icon/icons/github';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useAuth } from '@/features/providers/auth-provider';
import type {
  MarketplaceItem,
  MarketplaceItemDetail,
  MarketplaceSummary,
} from '@/lib/marketplace-client';
import { marketplaceItemHref, marketplaceSourceHref } from '@/lib/marketplace-slug';
import { AddToProjectModal } from './add-to-project-modal';
import { MarketplaceAvatar } from './marketplace-avatar';
import { displayCompanyLabel } from './marketplace-company-filter';
import { MarketplaceExploreCard } from './marketplace-explore-card';
import { MarketplaceFileView } from './marketplace-file-view';
import { groupMarketplaceItemsByType } from './marketplace-grid';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import {
  emptyDescriptionCopy,
  emptyReadmeCopy,
  groupCapabilities,
  marketplaceFileNodes,
  resolveBundleMembers,
  totalCapabilityCount,
} from './marketplace-item-view';
import { TypeTile, typeMeta } from './marketplace-meta';
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
    <h2 className="text-foreground mb-3 flex items-baseline gap-2 text-base font-medium">
      <span>{children}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground font-normal tabular-nums">{count}</span>
      ) : null}
    </h2>
  );
}

/** One provenance row in the detail rail: a fixed-width muted label lane and
 *  a value that truncates, so labels and values align across rows. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <dt className="text-muted-foreground w-16 shrink-0">{label}</dt>
      <dd className="text-foreground min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/** The install line for the terminal — the same id the CLI takes. Copy confirms
 *  in place (the icon swaps; nothing reflows). */
function InstallCommand({ itemId }: { itemId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const command = `kortix marketplace install ${itemId}`;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="bg-card flex items-center gap-3 rounded-md py-2 pr-2 pl-4">
      <code className="text-foreground min-w-0 flex-1 truncate font-mono text-sm">{command}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={tI18nComplete.raw(copied ? 'text8d525e5f158b' : 'text9a01feecae67')}
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => setCopied(true));
        }}
      >
        {copied ? <SolidCheckIcon className="size-4" /> : <Copy className="size-4" />}
      </Button>
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const surface = useMarketplaceSurface();
  // Prefer the member's own description; fall back to the type label (e.g. in a
  // flat bundle view where the type isn't already the section header).
  const subtitle = description?.trim() || (type ? typeMeta(type, tI18nComplete).label : null);
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
          <span className="text-muted-foreground block truncate text-xs">{subtitle}</span>
        ) : null}
      </span>
    </>
  );
  const rowClass =
    'hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors';
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
    <div className="bg-secondary rounded-md border px-4 py-2.5">
      <div className="prose-sm text-foreground max-w-none">
        <UnifiedMarkdown content={content} trust="untrusted" variant="document" />
      </div>
    </div>
  );
}

/** Line-clamped description with a Show more/less toggle (the rail is narrow). */
function ExpandableText({ text }: { text: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
          'text-foreground text-sm leading-relaxed text-pretty',
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
          {expanded ? tI18nComplete.raw('text94ea9b1d33a0') : tI18nComplete.raw('textf5c9bd131486')}
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
function ItemActions({
  data,
  compact = false,
}: {
  data: MarketplaceItemDetail;
  /** Page header: a content-width button beside the title instead of a full-width bar. */
  compact?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const surface = useMarketplaceSurface();
  const { user, isLoading: authLoading } = useAuth();

  const [addOpen, setAddOpen] = useState(false);

  const inProject = surface.variant === 'project';

  if (!authLoading && !user && surface.variant === 'public') {
    const redirectHref = surface.itemHref(data.id);
    return (
      <Button variant="default" className={cn('gap-1.5', !compact && 'w-full')} asChild>
        <Link href={`/auth?redirect=${encodeURIComponent(redirectHref)}`}>
          {tI18nComplete.raw('texte0ae10b8f4e7')}
          <ArrowRight className="size-4" />
        </Link>
      </Button>
    );
  }

  return (
    <>
      <div className={cn('flex items-center gap-2', !compact && 'w-full')}>
        <Button
          variant="default"
          className={cn('gap-1.5', !compact && 'flex-1')}
          disabled={authLoading}
          onClick={() => setAddOpen(true)}
        >
          {tI18nComplete.raw('text38d076d39951')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const surface = useMarketplaceSurface();
  const tm = typeMeta(data.type, tI18nComplete);
  const isProject = data.type === 'registry:project';
  const companyLabel = displayCompanyLabel(data.marketplaceId, data.marketplaceLabel);
  const sourceUrl = company?.sourceUrl ?? data.sourceUrl;
  const companyClickable = surface.variant === 'public';

  return (
    <>
      <div className="space-y-4">
        <MarketplaceItemAvatar item={data} size="lg" showSource={false} />

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
              <Github className="size-3.5" />
              {tI18nComplete.raw('text6ee818aa2de3')}
            </Link>
          ) : null}
        </div>
      </div>

      {data.partOfProject ? (
        <div>
          <SectionLabel>{tI18nComplete.raw('textc41720e33d45')}</SectionLabel>
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
        <FileTree title={tI18nComplete.raw('textabc7e9892806')}>
          <FileTreeNav
            nodes={marketplaceFileNodes(fileTargets)}
            selectedPath={selectedFile}
            onSelect={onSelectFile}
            label={`${itemTitle} files`}
          />
        </FileTree>
      ) : null}

      {companyClickable ? (
        <Link
          href={marketplaceSourceHref(data.marketplaceId)}
          className="group border-border/60 flex items-center gap-3 border-t pt-4 transition-transform active:scale-[0.998]"
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
          aria-label={tI18nComplete.raw('text81b35f1b4332')}
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-foreground min-w-[3.75rem] px-1 text-center text-xs font-medium tabular-nums">
          {nav.index} <span className="text-muted-foreground">/</span> {nav.total}
        </span>
        <button
          type="button"
          onClick={nav.onNext}
          disabled={!nav.onNext}
          aria-label={tI18nComplete.raw('text1e47d4f7a1a3')}
          className="text-muted-foreground hover:text-foreground hover:bg-muted flex size-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
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
  related = [],
  onBack,
  nav,
}: {
  data: MarketplaceItemDetail;
  company?: MarketplaceSummary;
  /** Cross-link discovery under the content (public page only): other projects
   *  for a project, other skills from the same source for anything else. */
  related?: MarketplaceItem[];
  /** In-project overlay: renders an embedded shell + a back-button crumb. */
  onBack?: () => void;
  /** Floating pager over the surrounding item list (← / → + position). */
  nav?: DetailNav;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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

  const capGroups = groupCapabilities(data.capabilities, tI18nComplete);
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
  // A project's agents + triggers (parsed from kortix.yaml) rendered with the
  // SAME card + name-based icon heuristic as its skills — just non-navigable,
  // since they aren't their own catalog items.
  const projectExtraGroups = useMemo(() => {
    if (!isProject) return [] as { label: string; items: MarketplaceItem[] }[];
    const toItem = (
      name: string,
      title: string,
      description: string | null,
      type: string,
      prefix: string,
    ): MarketplaceItem => ({
      id: `${prefix}:${name}`,
      registry: data.registry,
      name,
      type,
      title,
      description,
      categories: [],
      capabilities: { secrets: [], connectors: [], tools: [], network: [] },
      dependencies: [],
      fileCount: 0,
      external: data.external,
      marketplaceId: data.marketplaceId,
      marketplaceLabel: data.marketplaceLabel,
      owner: data.owner,
      sourceUrl: data.sourceUrl,
    });
    const groups: { label: string; items: MarketplaceItem[] }[] = [];
    if (data.projectAgents?.length) {
      groups.push({
        label: tI18nComplete.raw('text279b44d2ab4b'),
        items: data.projectAgents.map((a) =>
          toItem(a.name, a.title.replaceAll('-', ' '), a.description, 'registry:agent', 'agent'),
        ),
      });
    }
    if (data.projectTriggers?.length) {
      groups.push({
        label: tI18nComplete.raw('texte62f2148a64d'),
        items: data.projectTriggers.map((t) =>
          toItem(t.slug, t.slug.replaceAll('-', ' '), t.description, 'registry:trigger', 'trigger'),
        ),
      });
    }
    return groups;
  }, [
    isProject,
    data.projectAgents,
    data.projectTriggers,
    data.registry,
    data.external,
    data.marketplaceId,
    data.marketplaceLabel,
    data.owner,
    data.sourceUrl,
    tI18nComplete,
  ]);
  const readme = data.readme ? stripFrontmatter(data.readme) : '';
  const itemTitle = data.title.replaceAll('-', ' ');
  const companyLabel = displayCompanyLabel(data.marketplaceId, data.marketplaceLabel);

  // The sidebar Files tree selects which file the main column shows; it defaults
  // to the README/SKILL.md (whose already-SSR'd body the view reuses).
  const fileTargets = data.files.map((f) => f.target);
  const fileNodes = marketplaceFileNodes(fileTargets);
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
        { label: tI18nComplete.raw('textc608981d8d68'), onClick: onBack },
        ...(projectCrumb ? [projectCrumb] : []),
        { label: itemTitle },
      ]
    : [
        { label: tI18nComplete.raw('textc608981d8d68'), href: '/marketplace' },
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
          title={tI18nComplete.raw('textc219d96549eb')}
          description={emptyReadmeCopy(data.type)}
        />
      </section>
    );

  // Non-project bundles keep the flat "What's inside" row list; a project renders
  // its contents as marketplace cards (memberItemGroups) below its README.
  const membersSection =
    !isProject && isBundle && bundleMembers.length > 0 ? (
      <section>
        <SectionLabel count={bundleMembers.length}>
          {tI18nComplete.raw('text17d89116b971')}
        </SectionLabel>
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

  // Project contents + agents/triggers, as the SAME cards in the SAME grid as
  // the gallery. Shared by both layouts; `columns` follows the surface width.
  const projectSections = (gridClassName: string) => (
    <>
      {memberItemGroups.map((g) => (
        <section key={g.label}>
          <SectionLabel count={g.items.length}>{g.label}</SectionLabel>
          <div className={cn('grid gap-3', gridClassName)}>
            {g.items.map((it) => (
              <MarketplaceExploreCard key={it.id} item={it} showSource={false} />
            ))}
          </div>
        </section>
      ))}
      {projectExtraGroups.map((g) => (
        <section key={g.label}>
          <SectionLabel count={g.items.length}>{g.label}</SectionLabel>
          <div className={cn('grid gap-3', gridClassName)}>
            {g.items.map((it) => (
              <MarketplaceExploreCard key={it.id} item={it} showSource={false} navigable={false} />
            ))}
          </div>
        </section>
      ))}
    </>
  );

  const capabilitiesSection =
    capCount > 0 ? (
      <section>
        <SectionLabel count={capCount}>{tI18nComplete.raw('text143f0330d2de')}</SectionLabel>
        <div className="bg-card space-y-3 rounded-md px-4 py-2.5">
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
    ) : null;

  if (!onBack) {
    // Public page: one content column — back link, identity row with the
    // action, description, install line, files, contents, then related items.
    // The rail holds the file tree and provenance under the breadcrumb.
    const sourceUrl = company?.sourceUrl ?? data.sourceUrl;
    return (
      <MarketplaceShell
        crumbs={crumbs.slice(0, -1)}
        sidebar={
          <div className="space-y-8">
            {fileNodes.length > 0 ? (
              // `-mx-2.5` pulls the trigger and row fills out past the column
              // so their TEXT lands on the rail's left edge, in line with the
              // breadcrumb; the hover fills bleed into the gutter instead.
              <FileTree title={tI18nComplete.raw('textabc7e9892806')} className="-mx-2.5">
                <FadedScrollArea
                  fadeColor="from-background"
                  rootClassName="h-auto max-h-144"
                  className="overscroll-contain"
                >
                  <FileTreeNav
                    nodes={fileNodes}
                    selectedPath={selectedFile}
                    onSelect={setSelectedFile}
                    label={`${itemTitle} files`}
                  />
                </FadedScrollArea>
              </FileTree>
            ) : null}

            {/* Provenance as a two-lane list: labels in one fixed column,
                values in the next, so every row starts on the same x — the
                rail's left edge, shared with the breadcrumb and "Files". */}
            <dl className="space-y-3 text-sm">
              <MetaRow label={tI18nComplete.raw('text0e570ca6fabe')}>
                <Link
                  href={marketplaceSourceHref(data.marketplaceId)}
                  className="hover:text-foreground flex min-w-0 items-center gap-2 transition-colors duration-(--duration-normal)"
                >
                  <MarketplaceAvatar
                    id={data.marketplaceId}
                    owner={company?.owner ?? data.owner}
                    sourceUrl={sourceUrl}
                    label={data.marketplaceLabel}
                    size="xs"
                  />
                  <span className="truncate">{companyLabel}</span>
                </Link>
              </MetaRow>
              {data.partOfProject ? (
                <MetaRow label={tI18nComplete.raw('text985959785319')}>
                  <Link
                    href={marketplaceItemHref(data.partOfProject.id)}
                    className="hover:text-foreground block truncate transition-colors duration-(--duration-normal)"
                  >
                    {data.partOfProject.title}
                  </Link>
                </MetaRow>
              ) : null}
              {fileTargets.length > 0 ? (
                <MetaRow label={tI18nComplete.raw('textabc7e9892806')}>
                  <span className="tabular-nums">{fileTargets.length}</span>
                </MetaRow>
              ) : null}
            </dl>

            {sourceUrl ? (
              <div>
                <Link
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm transition-colors duration-(--duration-normal)"
                >
                  {tI18nComplete.raw('text6ee818aa2de3')}
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              </div>
            ) : null}
          </div>
        }
      >
        <div className="space-y-10">
          <header className="space-y-6">
            <Link
              href="/marketplace"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors duration-(--duration-normal)"
            >
              <ArrowLeft className="size-4" aria-hidden />
              {tI18nComplete.raw('text76900f1bfd16')}
            </Link>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-4">
                <MarketplaceItemAvatar item={data} size="md" showSource={false} />
                <h1 className="text-foreground min-w-0 text-2xl font-semibold tracking-tight text-balance capitalize">
                  {itemTitle}
                </h1>
              </div>
              <div className="shrink-0">
                <ItemActions data={data} compact />
              </div>
            </div>
            <ExpandableText text={data.description || emptyDescriptionCopy(data.type)} />
          </header>

          <InstallCommand itemId={data.id} />

          {isProject ? (
            <>
              {filesSection}
              {projectSections('sm:grid-cols-2')}
            </>
          ) : (
            <>
              {filesSection}
              {membersSection}
            </>
          )}

          {capabilitiesSection}

          {related.length > 0 ? (
            <section className="pt-10">
              <SectionLabel>
                {tI18nComplete.raw(isProject ? 'text7b4418d894c3' : 'text39207bf34111')}
              </SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                {related.map((item) => (
                  <MarketplaceExploreCard key={item.id} item={item} showSource={false} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </MarketplaceShell>
    );
  }

  return (
    <>
      {nav ? <DetailPager nav={nav} /> : null}
      <MarketplaceShell
        embedded
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
              {projectSections('sm:grid-cols-3')}
            </>
          ) : (
            <>
              {filesSection}
              {membersSection}
            </>
          )}

          {capabilitiesSection}
        </div>
      </MarketplaceShell>
    </>
  );
}
