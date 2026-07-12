'use client';

import { Boxes, ChevronLeft, ChevronRight, FileText, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { Icon } from '@/features/icon/icon';
import { useAuth } from '@/features/providers/auth-provider';
import { useUninstallMarketplaceItem } from '@/hooks/marketplace';
import type { MarketplaceItem, MarketplaceItemDetail, MarketplaceSummary } from '@/lib/marketplace-client';
import { marketplaceItemHref, marketplaceSourceHref } from '@/lib/marketplace-slug';
import { AddProjectToProjectModal } from './add-project-to-project-modal';
import { AddToProjectModal } from './add-to-project-modal';
import { MarketplaceAddButton } from './marketplace-add-button';
import { MarketplaceAvatar } from './marketplace-avatar';
import { MarketplaceCloneButton } from './marketplace-clone-button';
import { displayCompanyLabel } from './marketplace-company-filter';
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
function BundleMemberRow({ id, title, type }: { id: string; title: string; type: string | null }) {
  const { itemHref, openItem } = useMarketplaceSurface();
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
        {type ? (
          <span className="text-muted-foreground/70 block text-xs">{typeMeta(type).label}</span>
        ) : null}
      </span>
    </>
  );
  const rowClass = 'hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors';
  if (itemHref) {
    return (
      <Link href={itemHref(id)} className={rowClass}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => openItem(id)} className={rowClass}>
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

/** The primary CTA area — variant-driven. Public: clone / add-to-a-project
 *  (picker) / auth prompt. In-project: install into THIS project (no picker),
 *  with Re-install + Remove once installed. */
function ItemActions({ data }: { data: MarketplaceItemDetail }) {
  const surface = useMarketplaceSurface();
  const { user, isLoading: authLoading } = useAuth();
  const isProject = data.type === 'registry:project';

  const [addToExistingOpen, setAddToExistingOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const uninstall = useUninstallMarketplaceItem();

  // A whole project is always cloned as a NEW project (or agent-merged into an
  // existing one) — never fixed-installed — so its actions are the same on
  // both surfaces.
  if (isProject) {
    return (
      <>
        <MarketplaceCloneButton item={data} />
        {!authLoading && user ? (
          <button
            type="button"
            onClick={() => setAddToExistingOpen(true)}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Or install into a project you already have
          </button>
        ) : null}
        <AddProjectToProjectModal
          item={data}
          open={addToExistingOpen}
          onOpenChange={setAddToExistingOpen}
        />
      </>
    );
  }

  // A skill/agent/command on the public surface — auth-gated add via a picker.
  if (surface.variant === 'public') {
    return <MarketplaceAddButton item={data} />;
  }

  // In-project surface — install into the fixed project, no picker.
  const projectId = surface.projectId!;
  const installed = surface.installedNames.has(data.name);

  const onRemove = async () => {
    try {
      const res = await uninstall.mutateAsync({ projectId, name: data.name });
      successToast(`Removed ${data.name}`, {
        description: `Removed ${res.file_count} file${res.file_count === 1 ? '' : 's'} from the repo.`,
      });
      setRemoveOpen(false);
    } catch (e) {
      errorToast('Remove failed', { description: (e as Error).message });
    }
  };

  return (
    <>
      <div className="flex w-full items-center gap-2">
        <Button
          variant={installed ? 'secondary' : 'default'}
          className="flex-1 gap-1.5"
          onClick={() => setAddOpen(true)}
        >
          {installed ? 'Re-install' : 'Install into this project'}
        </Button>
        {installed ? (
          <Button
            variant="outline"
            size="icon"
            aria-label="Remove"
            onClick={() => setRemoveOpen(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
      <AddToProjectModal
        item={data}
        open={addOpen}
        onOpenChange={setAddOpen}
        fixedProjectId={projectId}
      />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`Remove ${data.title}?`}
        description="This commits a change removing its files from the project's repo. It stays available to re-install."
        confirmLabel="Remove"
        confirmVariant="destructive"
        confirmIcon={uninstall.isPending ? <Loading className="size-4 shrink-0" /> : undefined}
        isPending={uninstall.isPending}
        onConfirm={onRemove}
      />
    </>
  );
}

/** Identity + actions + metadata — the left rail (page) / top block (overlay). */
function ItemSidebar({
  data,
  company,
  itemTitle,
}: {
  data: MarketplaceItemDetail;
  company?: MarketplaceSummary;
  itemTitle: string;
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

      {data.files.length > 0 ? (
        <div className="space-y-2">
          <SectionLabel count={data.files.length}>Files</SectionLabel>
          <div className="bg-popover max-h-56 overflow-y-auto rounded-md border">
            <ul className="divide-border divide-y">
              {data.files.map((file) => (
                <li
                  key={file.target}
                  className="text-foreground/90 truncate px-3 py-2 font-mono text-xs"
                  title={file.target}
                >
                  {file.target}
                </li>
              ))}
            </ul>
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
  onPrev,
  onNext,
}: {
  data: MarketplaceItemDetail;
  company?: MarketplaceSummary;
  /** Other `registry:project` items, for cross-link discovery (public only). */
  otherProjects?: MarketplaceItem[];
  /** In-project overlay: renders an embedded shell + a back-button crumb. */
  onBack?: () => void;
  /** Step to the previous/next sibling item (← / →); absent → disabled. */
  onPrev?: () => void;
  onNext?: () => void;
}) {
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
  const readme = data.readme ? stripFrontmatter(data.readme) : '';
  const itemTitle = data.title.replaceAll('-', ' ');
  const companyLabel = displayCompanyLabel(data.marketplaceId, data.marketplaceLabel);

  const crumbs = onBack
    ? [{ label: 'Marketplace', onClick: onBack }, { label: itemTitle }]
    : [
        { label: 'Marketplace', href: '/marketplace' },
        { label: companyLabel, href: marketplaceSourceHref(data.marketplaceId) },
        { label: itemTitle },
      ];

  return (
    <MarketplaceShell
      embedded={!!onBack}
      crumbs={crumbs}
      sidebar={
        <>
          {onPrev || onNext ? (
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onPrev}
                disabled={!onPrev}
                aria-label="Previous item"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onNext}
                disabled={!onNext}
                aria-label="Next item"
              >
                <ChevronRight className="size-4" />
              </Button>
              <span className="text-muted-foreground/70 ml-1 text-xs">
                Use ← → to browse
              </span>
            </div>
          ) : null}
          <ItemSidebar data={data} company={company} itemTitle={itemTitle} />
        </>
      }
    >
      <div className="space-y-8">
        <section className="space-y-3">
          {readme ? (
            <ReadmeMarkdown content={readme} />
          ) : (
            <EmptyState
              icon={FileText}
              size="sm"
              title="No README"
              description={emptyReadmeCopy(data.type)}
            />
          )}
        </section>

        {isBundle && bundleMembers.length > 0 ? (
          <section>
            <SectionLabel count={bundleMembers.length}>What&rsquo;s inside</SectionLabel>
            <RowPanel>
              {bundleMembers.map((member) => (
                <BundleMemberRow
                  key={member.key}
                  id={member.key}
                  title={member.title}
                  type={member.type}
                />
              ))}
            </RowPanel>
          </section>
        ) : null}

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
  );
}
