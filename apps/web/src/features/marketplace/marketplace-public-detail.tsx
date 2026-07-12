'use client';

import { FileText } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useAuth } from '@/features/providers/auth-provider';
import type { MarketplaceItemDetail, MarketplaceSummary } from '@/lib/marketplace-client';
import { marketplaceCompanyHref, marketplaceItemHref } from '@/lib/marketplace-slug';
import { MarketplaceAddButton } from './marketplace-add-button';
import { MarketplaceAvatar } from './marketplace-avatar';
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

function CompanyAside({
  marketplaceId,
  marketplaceLabel,
  owner,
  sourceUrl,
  itemCount,
}: {
  marketplaceId: string;
  marketplaceLabel: string;
  owner?: string;
  sourceUrl?: string;
  itemCount?: number;
}) {
  const label = displayCompanyLabel(marketplaceId, marketplaceLabel);

  return (
    <aside className="min-w-0 space-y-4 lg:sticky lg:top-32 lg:self-start">
      <Link
        href={marketplaceCompanyHref(marketplaceId)}
        className="group block space-y-4 transition-transform active:scale-[0.96]"
      >
        <MarketplaceAvatar
          id={marketplaceId}
          owner={owner}
          sourceUrl={sourceUrl}
          label={marketplaceLabel}
          size="lg"
        />
        <div className="space-y-1">
          <h2 className="text-foreground text-lg font-medium tracking-tight text-balance group-hover:underline">
            {label}
          </h2>
          {itemCount !== undefined ? (
            <p className="text-muted-foreground text-sm tabular-nums">
              {itemCount} {itemCount === 1 ? 'item' : 'items'}
            </p>
          ) : null}
        </div>
      </Link>
      {sourceUrl ? (
        <Button variant="secondary" size="sm" asChild>
          <Link href={sourceUrl} target="_blank" rel="noopener noreferrer">
            View source
          </Link>
        </Button>
      ) : null}
    </aside>
  );
}

function BundleMemberRow({
  title,
  type,
  href,
}: {
  title: string;
  type: string | null;
  href: string | null;
}) {
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
  if (href) {
    return (
      <Link
        href={href}
        className="hover:bg-muted/50 flex items-center gap-3 px-4 py-2.5 transition-colors"
      >
        {body}
      </Link>
    );
  }
  return <div className="flex items-center gap-3 px-4 py-2.5">{body}</div>;
}

function CollapsibleMarkdown({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el || expanded) {
      return;
    }
    setCanExpand(el.scrollHeight > el.clientHeight + 1);
  }, [expanded]);

  useLayoutEffect(() => {
    checkOverflow();
  }, [checkOverflow, content]);

  useEffect(() => {
    const el = scrollRef.current;
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
    <div className="bg-secondary relative overflow-hidden rounded-md border p-4">
      <FadedScrollArea
        ref={scrollRef}
        fadeColor="from-secondary"
        className={cn(!expanded && 'max-h-[2400px] sm:max-h-[560px]')}
      >
        <div className="prose-sm text-foreground/90 max-w-none">
          <UnifiedMarkdown content={content} allowHtml={false} />
        </div>
      </FadedScrollArea>
      {canExpand && !expanded ? (
        <>
          <div
            className="from-secondary pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t to-transparent"
            aria-hidden
          />
          <Button
            variant="outline"
            size="sm"
            className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2"
            onClick={() => setExpanded(true)}
          >
            Show more
          </Button>
        </>
      ) : null}
    </div>
  );
}

export function MarketplacePublicDetail({
  data,
  company,
}: {
  data: MarketplaceItemDetail;
  company?: MarketplaceSummary;
}) {
  const tm = typeMeta(data.type);
  const { user, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  const capGroups = groupCapabilities(data.capabilities);
  const capCount = totalCapabilityCount(data.capabilities);
  const isBundle = data.type === 'registry:bundle';
  const bundleMembers = isBundle
    ? resolveBundleMembers({
        dependencies: data.dependencies,
        dependencyItems: data.dependencyItems,
        hrefForId: marketplaceItemHref,
      })
    : [];
  const readme = data.readme ? stripFrontmatter(data.readme) : '';
  const itemTitle = data.title.replaceAll('-', ' ');
  const companyLabel = displayCompanyLabel(data.marketplaceId, data.marketplaceLabel);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-28 pb-24 lg:px-0 lg:pt-32">
      <div className="grid grid-cols-12 gap-6 lg:gap-8">
        <div className="col-span-12">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/marketplace">Marketplace</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbLink asChild>
                  <Link href={marketplaceCompanyHref(data.marketplaceId)} className="truncate">
                    {companyLabel}
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate capitalize">{itemTitle}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        <div className="col-span-12 lg:col-span-3">
          <CompanyAside
            marketplaceId={data.marketplaceId}
            marketplaceLabel={data.marketplaceLabel}
            owner={company?.owner ?? data.owner}
            sourceUrl={company?.sourceUrl ?? data.sourceUrl}
            itemCount={company?.count}
          />
        </div>

        <div className="min-w-0 space-y-8 lg:col-span-9">
          <header className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <MarketplaceItemAvatar item={data} size="md" showSource={false} />
                <div className="min-w-0 space-y-1">
                  <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance capitalize sm:text-3xl">
                    {itemTitle}
                  </h1>
                  <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                    <tm.Icon className="size-3.5 shrink-0" />
                    {tm.label}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <MarketplaceAddButton item={data} />
                {!authLoading && !user ? (
                  <Link
                    href={`/auth?redirect=${encodeURIComponent(pathname)}`}
                    className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                  >
                    Sign in to add to a project
                  </Link>
                ) : null}
              </div>
            </div>
            <p className="text-foreground text-base leading-relaxed text-pretty">
              {data.description || emptyDescriptionCopy(data.type)}
            </p>
          </header>

          {isBundle && bundleMembers.length > 0 ? (
            <section>
              <SectionLabel count={bundleMembers.length}>What&rsquo;s inside</SectionLabel>
              <RowPanel>
                {bundleMembers.map((member) => (
                  <BundleMemberRow
                    key={member.key}
                    title={member.title}
                    type={member.type}
                    href={member.href}
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

          {data.files.length > 0 ? (
            <section>
              <SectionLabel count={data.files.length}>Files</SectionLabel>
              <div className="bg-popover max-h-72 overflow-y-auto rounded-md border">
                <ul className="divide-border divide-y">
                  {data.files.map((file) => (
                    <li
                      key={file.target}
                      className="text-foreground/90 truncate px-4 py-2 font-mono text-xs"
                      title={file.target}
                    >
                      {file.target}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <section className="space-y-3">
            {readme ? (
              <CollapsibleMarkdown content={readme} />
            ) : (
              <EmptyState
                icon={FileText}
                size="sm"
                title="No README"
                description={emptyReadmeCopy(data.type)}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
