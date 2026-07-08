'use client';

import { ExternalLink, FileText } from 'lucide-react';

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
import { ButtonGroup } from '@/components/ui/button-group';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useMarketplaceItem } from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { TrashSolid } from '@mynaui/icons-react';
import { Icon } from '../icon/icon';
import { MarketplaceAvatar } from './marketplace-avatar';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { TypeTile, typeMeta } from './marketplace-meta';
import {
  emptyDescriptionCopy,
  emptyReadmeCopy,
  groupCapabilities,
  resolveBundleMembers,
  totalCapabilityCount,
} from './marketplace-item-view';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground/60 mb-3 text-xs font-medium">{children}</div>;
}

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

export function MarketplaceItemDetail({
  onBack,
  onAdd,
  onRemove,
  addLabel = 'Add to Kortix',
  installedNames,
}: {
  onBack: () => void;
  onAdd: (item: MarketplaceItem) => void;
  onRemove?: (item: MarketplaceItem) => void;
  addLabel?: string;
  installedNames?: Set<string>;
}) {
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);
  const { data, isLoading } = useMarketplaceItem(openId);
  const tm = data ? typeMeta(data.type) : null;
  const capGroups = groupCapabilities(data?.capabilities);
  const capCount = totalCapabilityCount(data?.capabilities);
  const readme = data?.readme ? stripFrontmatter(data.readme) : '';
  const isInstalled = !!(data && installedNames?.has(data.name));
  const isBundle = data?.type === 'registry:bundle';
  const bundleMembers =
    data && isBundle
      ? resolveBundleMembers({
          dependencies: data.dependencies,
          dependencyItems: data.dependencyItems,
          hrefForId: (id) => id,
        })
      : [];

  const actions = !data ? null : isInstalled ? (
    <ButtonGroup>
      <Button variant="outline" size="sm" onClick={() => onAdd(data)}>
        Re-install
      </Button>
      {onRemove && (
        <Button variant="outline" size="sm" onClick={() => onRemove(data)}>
          <TrashSolid className="size-4" />
        </Button>
      )}
    </ButtonGroup>
  ) : (
    <Button variant="secondary" size="sm" className="shrink-0" onClick={() => onAdd(data)}>
      <Icon.Plus className="size-4" />
      {addLabel}
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Breadcrumb className="p-4 pb-0">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button type="button" onClick={onBack}>
                Marketplace
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {data?.title && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{data.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-10 pb-20 lg:py-16">
          {isLoading || !data || !tm ? (
            <div className="space-y-6">
              <Skeleton className="h-4 w-40 rounded" />
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-4">
                  <Skeleton className="size-14 rounded-md" />
                  <Skeleton className="h-8 w-48 rounded" />
                </div>
                <Skeleton className="h-9 w-32 rounded-md" />
              </div>
              <Skeleton className="h-4 w-full max-w-md rounded" />
              <Skeleton className="h-64 w-full rounded-lg" />
            </div>
          ) : (
            <>
              <header className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-4">
                    <MarketplaceItemAvatar item={data} size="lg" showSource={false} />
                    <h1 className="text-foreground text-2xl font-semibold tracking-tight">
                      {data.title}
                    </h1>
                  </div>
                  {actions}
                </div>

                <p className="text-muted-foreground max-w-prose text-sm leading-relaxed text-pretty">
                  {data.description || emptyDescriptionCopy(data.type)}
                </p>

                <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <MarketplaceAvatar
                      id={data.marketplaceId}
                      owner={data.owner}
                      sourceUrl={data.sourceUrl}
                      label={data.marketplaceLabel}
                      size="xs"
                    />
                    {data.sourceUrl ? (
                      <a
                        href={data.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-foreground inline-flex min-w-0 items-center gap-1 transition-colors"
                      >
                        <span className="truncate">{data.marketplaceLabel}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="truncate">{data.marketplaceLabel}</span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <tm.Icon className="size-3.5 shrink-0" />
                    {tm.label}
                  </span>
                </div>
              </header>

              {isBundle && bundleMembers.length > 0 && (
                <section>
                  <SectionLabel>What&rsquo;s inside {bundleMembers.length}</SectionLabel>
                  <ul className="space-y-2">
                    {bundleMembers.map((member) => (
                      <li key={member.key}>
                        <button
                          type="button"
                          disabled={!member.href}
                          onClick={() => member.href && openItem(member.href)}
                          className="group bg-popover hover:bg-muted/70 disabled:hover:bg-popover flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-default"
                        >
                          {member.type ? (
                            <TypeTile type={member.type} size="sm" />
                          ) : (
                            <span className="bg-foreground/5 text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                              <FileText className="size-4" />
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="text-foreground block truncate text-sm font-medium">
                              {member.title}
                            </span>
                            {member.type && (
                              <span className="text-muted-foreground block text-xs">
                                {typeMeta(member.type).label}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {capCount > 0 && (
                <section>
                  <SectionLabel>Requires {capCount}</SectionLabel>
                  <div className="space-y-3">
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
              )}

              {data.files.length > 0 && (
                <section>
                  <SectionLabel>Files {data.files.length}</SectionLabel>
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
              )}

              <section>
                {readme ? (
                  <div className="prose-sm text-foreground/90 max-w-none">
                    <UnifiedMarkdown content={readme} allowHtml={false} />
                  </div>
                ) : (
                  <EmptyState
                    icon={FileText}
                    title="No README"
                    description={emptyReadmeCopy(data.type)}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
