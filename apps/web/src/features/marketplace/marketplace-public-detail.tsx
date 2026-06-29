'use client';

import { FileText, KeyRound, Layers, Plug, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { UnifiedMarkdown } from '@/components/markdown';
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
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useMarketplaceItem, useMarketplaces } from '@/hooks/marketplace';
import { marketplaceCompanyHref, marketplaceItemHref } from '@/lib/marketplace-slug';
import { MarketplaceAddButton } from './marketplace-add-button';
import { MarketplaceAvatar } from './marketplace-avatar';
import { displayCompanyLabel } from './marketplace-company-filter';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { typeMeta } from './marketplace-meta';

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

function MetaRow({
  icon: IconComponent,
  title,
  subtitle,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  href?: string;
}) {
  const body = (
    <>
      <IconComponent className="text-muted-foreground size-4 shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{title}</span>
      {subtitle ? (
        <span className="text-muted-foreground/70 shrink-0 text-xs">{subtitle}</span>
      ) : null}
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

function DetailSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-6 lg:gap-8">
      <div className="col-span-12 space-y-3">
        <Skeleton className="h-4 w-56 rounded" />
      </div>
      <div className="col-span-12 space-y-4 lg:col-span-3">
        <Skeleton className="size-14 rounded-md" />
        <Skeleton className="h-5 w-32 rounded" />
        <Skeleton className="h-4 w-20 rounded" />
      </div>
      <div className="col-span-12 space-y-8 lg:col-span-9">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Skeleton className="size-10 rounded-md" />
            <Skeleton className="h-8 w-56 rounded" />
          </div>
          <Skeleton className="h-9 w-36 rounded-md" />
        </div>
        <Skeleton className="h-4 w-full max-w-md rounded" />
        <Skeleton className="h-72 w-full rounded-md" />
      </div>
    </div>
  );
}

export function MarketplacePublicDetail({ id }: { id: string }) {
  const { data, isLoading, isError } = useMarketplaceItem(id, { publicOnly: true });
  const marketplacesQuery = useMarketplaces({ publicOnly: true });

  const company = useMemo(
    () => marketplacesQuery.data?.marketplaces.find((m) => m.id === data?.marketplaceId),
    [marketplacesQuery.data, data?.marketplaceId],
  );

  const tm = data ? typeMeta(data.type) : null;
  const caps = data?.capabilities;
  const capItems = caps
    ? [
        ...caps.secrets.map((s) => ({ kind: 'secret' as const, id: s })),
        ...caps.connectors.map((c) => ({ kind: 'connector' as const, id: c })),
        ...caps.tools.map((t) => ({ kind: 'tool' as const, id: t })),
      ]
    : [];
  const readme = data?.readme ? stripFrontmatter(data.readme) : '';
  const itemTitle = data?.title.replaceAll('-', ' ') ?? '';
  const companyLabel = data ? displayCompanyLabel(data.marketplaceId, data.marketplaceLabel) : '';

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-28 pb-24 lg:px-0 lg:pt-32">
      {isLoading ? (
        <DetailSkeleton />
      ) : isError || !data || !tm ? (
        <div className="py-16">
          <EmptyState
            icon={FileText}
            title="Item not found"
            description="This marketplace item doesn't exist or isn't available."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/marketplace">Back to marketplace</Link>
              </Button>
            }
          />
        </div>
      ) : (
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
                  <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance capitalize sm:text-3xl">
                    {itemTitle}
                  </h1>
                </div>
                <MarketplaceAddButton item={data} />
              </div>
              {data.description ? (
                <p className="text-foreground text-base leading-relaxed text-pretty">
                  {data.description}
                </p>
              ) : null}
            </header>

            {capItems.length > 0 ? (
              <section>
                <SectionLabel count={capItems.length}>Permissions</SectionLabel>
                <RowPanel>
                  {capItems.map((item) =>
                    item.kind === 'secret' ? (
                      <MetaRow
                        key={`secret:${item.id}`}
                        icon={KeyRound}
                        title={item.id}
                        subtitle="Secret"
                      />
                    ) : item.kind === 'connector' ? (
                      <MetaRow
                        key={`connector:${item.id}`}
                        icon={Plug}
                        title={item.id}
                        subtitle="Connector"
                      />
                    ) : (
                      <MetaRow
                        key={`tool:${item.id}`}
                        icon={Wrench}
                        title={item.id}
                        subtitle="Tool"
                      />
                    ),
                  )}
                </RowPanel>
              </section>
            ) : null}

            {data.dependencyItems.length > 0 ? (
              <section>
                <SectionLabel count={data.dependencyItems.length}>Includes</SectionLabel>
                <RowPanel>
                  {data.dependencyItems.map((dep) => (
                    <MetaRow
                      key={dep.id}
                      icon={Layers}
                      title={dep.title}
                      subtitle={typeMeta(dep.type).label}
                      href={marketplaceItemHref(dep.id)}
                    />
                  ))}
                </RowPanel>
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
                  description="This item doesn't ship a README yet."
                />
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
