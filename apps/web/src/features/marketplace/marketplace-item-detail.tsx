'use client';

import { ExternalLink, FileText, KeyRound, Plug, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';

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
import { typeMeta } from './marketplace-meta';

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

function CapabilityCard({
  icon: IconComponent,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="bg-muted/40 flex items-start gap-3 rounded-lg px-4 py-3">
      <IconComponent className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <div className="text-foreground truncate text-sm font-medium">{title}</div>
        <div className="text-muted-foreground text-xs">{subtitle}</div>
      </div>
    </div>
  );
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const { data, isLoading } = useMarketplaceItem(openId);
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
  const isInstalled = !!(data && installedNames?.has(data.name));

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

                {data.description && (
                  <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
                    {data.description}
                  </p>
                )}

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

              {capItems.length > 0 && (
                <section>
                  <SectionLabel>Permissions {capItems.length}</SectionLabel>
                  <div className="space-y-2">
                    {capItems.map((item) => {
                      if (item.kind === 'secret') {
                        return (
                          <CapabilityCard
                            key={`secret:${item.id}`}
                            icon={KeyRound}
                            title={item.id}
                            subtitle="Secret"
                          />
                        );
                      }
                      if (item.kind === 'connector') {
                        return (
                          <CapabilityCard
                            key={`connector:${item.id}`}
                            icon={Plug}
                            title={item.id}
                            subtitle="Connector"
                          />
                        );
                      }
                      return (
                        <CapabilityCard
                          key={`tool:${item.id}`}
                          icon={Wrench}
                          title={item.id}
                          subtitle="Tool"
                        />
                      );
                    })}
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
                    title={tI18nHardcoded.raw(
                      'autoComponentsMarketplaceMarketplaceItemDetailJsxAttrTitleNoREADME4966916b',
                    )}
                    description={tI18nHardcoded.raw(
                      'autoComponentsMarketplaceMarketplaceItemDetailJsxAttrDescriptionThisSkill2316ce31',
                    )}
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
