'use client';

import {
  ArrowLeftIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import Image from 'next/image';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { cn } from '@/lib/utils';
import {
  type ComposioTool,
  type ComposioToolkit,
  connectComposioToolkit,
  listComposioToolkits,
  listComposioTools,
} from '@kortix/sdk';
import { proposeComposioConnectorSlug } from './connector-profile-form';

export function ComposioToolsCatalogue({
  projectId,
  existingSlugs,
  onAdded,
}: {
  projectId: string;
  existingSlugs: readonly string[];
  onAdded: (slug?: string) => void;
}) {
  const [q, setQ] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const [selectedToolkit, setSelectedToolkit] = useState<ComposioToolkit | null>(null);
  const toolkitsQuery = useInfiniteQuery({
    queryKey: ['composio-toolkits', projectId, q],
    queryFn: ({ pageParam }) =>
      listComposioToolkits(projectId, q || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
  });
  const toolsQuery = useInfiniteQuery({
    queryKey: ['composio-tools', projectId, selectedToolkit?.slug, toolQuery],
    queryFn: ({ pageParam }) => {
      if (!selectedToolkit) throw new Error('Select a toolkit');
      return listSelectedToolkitTools(
        projectId,
        selectedToolkit,
        toolQuery,
        pageParam as string | undefined,
      );
    },
    enabled: selectedToolkit !== null,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
  });
  const connectToolkit = useMutation({
    mutationFn: async () => {
      if (!selectedToolkit) throw new Error('Select a toolkit');
      const slug = proposeComposioConnectorSlug(selectedToolkit.slug, existingSlugs);
      const result = await connectComposioToolkit(projectId, selectedToolkit.slug, {
        connectorSlug: slug,
        name: selectedToolkit.name,
      });
      return {
        slug,
        name: selectedToolkit.name,
        connected: result.connected,
        authorizationUrl: result.authorizationUrl,
      };
    },
    onSuccess: ({ slug, name, connected, authorizationUrl }) => {
      if (authorizationUrl) {
        successToast(`Added ${name}. Complete authorization to activate its tools.`);
        window.location.assign(authorizationUrl);
        return;
      }
      successToast(connected ? `Connected ${name}` : `Added ${name}`);
      onAdded(slug);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to connect toolkit'),
  });

  const toolkits = (toolkitsQuery.data?.pages ?? []).flatMap((page) => page.toolkits);
  const tools = (toolsQuery.data?.pages ?? []).flatMap((page) => page.tools);

  if (selectedToolkit) {
    return (
      <ToolkitTools
        toolkit={selectedToolkit}
        tools={tools}
        query={toolQuery}
        loading={toolsQuery.isLoading}
        error={toolsQuery.isError}
        hasNextPage={toolsQuery.hasNextPage}
        loadingNextPage={toolsQuery.isFetchingNextPage}
        connecting={connectToolkit.isPending}
        onQueryChange={setToolQuery}
        onBack={() => {
          setSelectedToolkit(null);
          setToolQuery('');
        }}
        onConnect={() => connectToolkit.mutate()}
        onRetry={() => void toolsQuery.refetch()}
        onLoadMore={() => void toolsQuery.fetchNextPage()}
      />
    );
  }

  return (
    <div>
      <InputGroupSearch>
        <InputGroupSearchIcon>
          <MagnifyingGlassIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search Composio toolkits"
          variant="popover"
        />
        <InputGroupSearchClear onClick={() => setQ('')} />
      </InputGroupSearch>
      <div className="overflow-y-auto py-4">
        {toolkitsQuery.isError ? (
          <InfoBanner
            tone="warning"
            title="Toolkits could not load"
            action={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => toolkitsQuery.refetch()}
              >
                Retry
              </Button>
            }
          >
            Composio did not return the toolkit catalogue.
          </InfoBanner>
        ) : toolkitsQuery.isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 12 }).map((_, index) => (
              <Skeleton key={index} className="h-[112px] w-full rounded-md" />
            ))}
          </div>
        ) : toolkits.length === 0 && toolkitsQuery.hasNextPage ? (
          <div>
            <EmptyState
              icon={MagnifyingGlassIcon}
              title="No matches yet"
              description="Composio has more toolkits to search."
            />
            <LoadMoreButton
              pending={toolkitsQuery.isFetchingNextPage}
              onClick={() => toolkitsQuery.fetchNextPage()}
            />
          </div>
        ) : toolkits.length === 0 ? (
          <EmptyState
            icon={MagnifyingGlassIcon}
            title="No toolkits found"
            description={q ? `Nothing matches "${q}".` : 'Composio returned no toolkits.'}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {toolkits.map((toolkit) => (
                <button
                  key={toolkit.slug}
                  type="button"
                  onClick={() => setSelectedToolkit(toolkit)}
                  className="group bg-popover hover:bg-muted/80 focus-visible:ring-primary/50 flex min-h-[112px] flex-col rounded-md border p-3.5 text-left transition-[background-color,color,scale] focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]"
                >
                  <div className="flex items-center gap-3">
                    <ToolkitMark toolkit={toolkit} />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm font-medium">
                        {toolkit.name}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {toolkit.toolsCount === null ? toolkit.slug : `${toolkit.toolsCount} tools`}
                      </div>
                    </div>
                    <PlusIcon className="text-muted-foreground/40 group-hover:text-primary size-4 shrink-0 transition-colors" />
                  </div>
                  <p className="text-muted-foreground mt-2 line-clamp-2 min-h-[2rem] text-xs leading-relaxed">
                    {toolkit.description ?? ' '}
                  </p>
                  <div className="mt-auto flex flex-wrap gap-1 pt-3">
                    <Badge variant={toolkit.authRequired ? 'warning' : 'success'} size="xs">
                      {toolkit.authRequired ? 'Auth required' : 'No auth'}
                    </Badge>
                    {toolkit.categories.slice(0, 1).map((category) => (
                      <Badge key={category} variant="muted" size="xs">
                        {category}
                      </Badge>
                    ))}
                  </div>
                </button>
              ))}
            </div>
            {toolkitsQuery.hasNextPage && (
              <LoadMoreButton
                pending={toolkitsQuery.isFetchingNextPage}
                onClick={() => toolkitsQuery.fetchNextPage()}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ToolkitTools({
  toolkit,
  tools,
  query,
  loading,
  error,
  hasNextPage,
  loadingNextPage,
  connecting,
  onQueryChange,
  onBack,
  onConnect,
  onRetry,
  onLoadMore,
}: {
  toolkit: ComposioToolkit;
  tools: ComposioTool[];
  query: string;
  loading: boolean;
  error: boolean;
  hasNextPage: boolean;
  loadingNextPage: boolean;
  connecting: boolean;
  onQueryChange: (value: string) => void;
  onBack: () => void;
  onConnect: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Hint label="Back to toolkits">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mt-0.5 size-10 shrink-0"
              aria-label="Back to toolkits"
              onClick={onBack}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          </Hint>
          <ToolkitMark toolkit={toolkit} className="mt-0.5" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-foreground truncate text-base font-medium">{toolkit.name}</h3>
              <Badge variant="muted" size="xs">
                {toolkit.slug}
              </Badge>
              <Badge variant={toolkit.authRequired ? 'warning' : 'success'} size="xs">
                {toolkit.authRequired ? 'Auth required' : 'No auth'}
              </Badge>
            </div>
            {toolkit.description && (
              <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                {toolkit.description}
              </p>
            )}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={connecting}
          onClick={onConnect}
          className="h-9 shrink-0"
        >
          {connecting ? (
            <Loading className="size-4 shrink-0" />
          ) : (
            <PlusIcon className="size-4 shrink-0" />
          )}
          Connect toolkit
        </Button>
      </div>
      <InputGroupSearch>
        <InputGroupSearchIcon>
          <MagnifyingGlassIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={`Search ${toolkit.name} tools`}
          variant="popover"
        />
        <InputGroupSearchClear onClick={() => onQueryChange('')} />
      </InputGroupSearch>
      {error ? (
        <InfoBanner
          tone="warning"
          title="Tools could not load"
          action={
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          Composio did not return tools for this toolkit.
        </InfoBanner>
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[88px] w-full rounded-md" />
          ))}
        </div>
      ) : tools.length === 0 ? (
        <EmptyState
          icon={MagnifyingGlassIcon}
          title="No tools found"
          description={query ? `Nothing matches "${query}".` : 'This toolkit has no listed tools.'}
        />
      ) : (
        <>
          <div className="divide-border overflow-hidden rounded-md border">
            {tools.map((tool) => (
              <div key={tool.slug} className="bg-popover flex gap-3 p-3.5">
                <EntityAvatar icon={WrenchIcon} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-foreground truncate text-sm font-medium">{tool.name}</div>
                    <Badge variant="muted" size="xs">
                      {tool.slug}
                    </Badge>
                    <Badge variant={tool.authRequired ? 'warning' : 'success'} size="xs">
                      {tool.authRequired ? 'Auth required' : 'No auth'}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-1 text-xs">{tool.toolkitSlug}</div>
                  {tool.description && (
                    <p className="text-muted-foreground mt-2 line-clamp-2 text-xs leading-relaxed">
                      {tool.description}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {hasNextPage && <LoadMoreButton pending={loadingNextPage} onClick={onLoadMore} />}
        </>
      )}
    </div>
  );
}

function listSelectedToolkitTools(
  projectId: string,
  selectedToolkit: ComposioToolkit,
  q: string,
  cursor: string | undefined,
) {
  return listComposioTools(projectId, selectedToolkit.slug, q || undefined, cursor);
}

function ToolkitMark({ toolkit, className }: { toolkit: ComposioToolkit; className?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!toolkit.iconUrl || imageFailed) {
    return <EntityAvatar icon={CubeIcon} size="sm" className={className} />;
  }
  return (
    <span
      className={cn(
        'border-border/60 bg-card relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border',
        className,
      )}
    >
      <Image
        src={toolkit.iconUrl}
        alt=""
        fill
        sizes="32px"
        className="object-contain p-1"
        referrerPolicy="no-referrer"
        unoptimized
        onError={() => setImageFailed(true)}
      />
    </span>
  );
}

function LoadMoreButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-center pt-5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={pending}
        className="h-9 px-8"
      >
        {pending ? (
          <>
            <Loading className="size-4 shrink-0" />
            Loading
          </>
        ) : (
          'Load more'
        )}
      </Button>
    </div>
  );
}
