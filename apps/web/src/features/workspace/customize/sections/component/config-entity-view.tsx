'use client';

import { UnifiedMarkdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
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
import { ErrorState } from '@/features/layout/section/error-state';
import { MarketplaceSectionButton } from '@/features/workspace/customize/marketplace-section-button';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { splitFrontmatter } from '@/features/workspace/customize/shared/utils';
import {
  editConfigPrompt,
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { cn } from '@/lib/utils';
import {
  type ProjectConfigSummary,
  getProjectDetail,
  readProjectFile,
} from '@kortix/sdk/projects-client';
import { DangerTriangleSolid, Pencil, Search } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Copy, type LucideIcon, Plus } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

export type ConfigEntity = { name: string; path: string; description: string | null };

const SKELETON_ROWS = ['a', 'b', 'c', 'd', 'e'];

/** The kind of artifact this view edits — drives the configure-thread prompts. */
type ConfigKind = 'agent' | 'skill' | 'command';

export interface ConfigEntityViewProps<T extends ConfigEntity> {
  projectId: string;
  kind: ConfigKind;
  /** Lowercase singular used in inline copy ("No matches", "{noun} body is empty"). */
  noun: string;

  // Section shell
  title: string;
  description: string;
  docs?: string;

  // Search
  searchPlaceholder: string;

  // Empty state
  emptyIcon: LucideIcon;
  emptyTitle: string;
  emptyDescription?: string;
  emptyDocsHref?: string;

  // Data
  select: (config: ProjectConfigSummary) => T[];
  matches?: (entity: T, query: string) => boolean;

  // Row + detail customization
  triggerVariant?: 'popover' | 'accent';
  renderTriggerLabel: (entity: T) => ReactNode;
  renderRowTrailing?: (entity: T, config: ProjectConfigSummary) => ReactNode;
  renderDetailTitle: (entity: T) => ReactNode;
  renderDetailMeta?: (entity: T, config: ProjectConfigSummary) => ReactNode;
  /** Rendered in the detail panel between the header block and the source body
   *  — e.g. the per-agent scope (env/connectors/CLI). Read-only. */
  renderDetailExtra?: (entity: T, config: ProjectConfigSummary) => ReactNode;
  emptyBodyLabel: string;

  /** Section-level context rendered above the search (e.g. kortix.toml manifest). */
  renderContext?: (config: ProjectConfigSummary) => ReactNode;

  /**
   * 'accordion' (default) — a vertical list where each row expands its detail
   * inline. 'split' — a master-detail layout: a selectable list on the LEFT, the
   * selected entity's source in the MIDDLE, and `renderDetailExtra` as a right
   * aside. Use 'split' for agents (the detail carries scope/model/assignment
   * cards that deserve their own column). Widens the section to fit three panes.
   */
  layout?: 'accordion' | 'split';
}

export function ConfigEntityView<T extends ConfigEntity>(props: ConfigEntityViewProps<T>) {
  const {
    projectId,
    kind,
    noun,
    title,
    description,
    docs,
    searchPlaceholder,
    emptyIcon: EmptyIcon,
    emptyTitle,
    emptyDescription,
    emptyDocsHref,
    select,
    matches,
    triggerVariant = 'popover',
    renderTriggerLabel,
    renderRowTrailing,
    renderDetailTitle,
    renderDetailMeta,
    renderDetailExtra,
    emptyBodyLabel,
    renderContext,
    layout = 'accordion',
  } = props;

  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const config = detailQuery.data?.config ?? null;
  const entities = useMemo(() => (config ? select(config) : []), [config, select]);
  const isForbidden =
    detailQuery.isError && /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entities;
    const test = matches ?? defaultMatches;
    return entities.filter((entity) => test(entity, q));
  }, [entities, query, matches]);

  const configure = useConfigureThread(projectId);

  // Master-detail selection (split layout). The right pane follows this; falls
  // back to the first visible entity so there's always something previewed.
  const selected = filtered.find((e) => e.path === selectedPath) ?? filtered[0] ?? null;

  const searchInput = (
    <InputGroupSearch>
      <InputGroupSearchIcon>
        <Search />
      </InputGroupSearchIcon>
      <InputGroupSearchInput
        placeholder={searchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        variant="popover"
      />
      <InputGroupSearchClear onClick={() => setQuery('')} />
    </InputGroupSearch>
  );

  // Pre-list states (loading / no-access / error / empty). Null once there are
  // entities to render — the caller then draws the list. Shared by both layouts.
  const stateContent = detailQuery.isLoading ? (
    <div className="space-y-2">
      {SKELETON_ROWS.map((row) => (
        <Skeleton key={row} className="h-9 rounded-md" />
      ))}
    </div>
  ) : isForbidden ? (
    <InfoBanner tone="warning" icon={DangerTriangleSolid} title="Access required">
      You don&apos;t have permission to read this repository.
    </InfoBanner>
  ) : detailQuery.isError ? (
    <ErrorState
      size="sm"
      title="Failed to load"
      description={(detailQuery.error as Error)?.message ?? `Failed to load ${noun}s`}
      action={
        <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
          Retry
        </Button>
      }
    />
  ) : entities.length === 0 ? (
    <EmptyState
      icon={EmptyIcon}
      size="sm"
      title={emptyTitle}
      action={
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => configure.start(newConfigPrompt(kind))}
            disabled={configure.pending}
          >
            {configure.pending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <Plus className="size-3.5 shrink-0" />
            )}
            Create {noun}
          </Button>
          {emptyDocsHref ? (
            <Button asChild variant="ghost" size="sm" className="gap-1.5">
              <a href={emptyDocsHref} target="_blank" rel="noopener noreferrer">
                Docs
              </a>
            </Button>
          ) : null}
        </div>
      }
    />
  ) : null;

  const noMatches = (
    <p className="text-muted-foreground px-3 py-6 text-center text-xs">
      No matches for <span className="text-foreground font-mono">{query}</span>.
    </p>
  );

  const accordionBody = (
    <div className="space-y-4">
      {config && entities.length > 0 && renderContext ? renderContext(config) : null}
      {searchInput}
      {stateContent ??
        (filtered.length === 0 ? (
          noMatches
        ) : config ? (
          <ul className="space-y-2">
            {filtered.map((entity) => (
              <li key={entity.path}>
                <EntityDisclosure
                  projectId={projectId}
                  kind={kind}
                  entity={entity}
                  config={config}
                  triggerVariant={triggerVariant}
                  renderTriggerLabel={renderTriggerLabel}
                  renderRowTrailing={renderRowTrailing}
                  renderDetailTitle={renderDetailTitle}
                  renderDetailMeta={renderDetailMeta}
                  renderDetailExtra={renderDetailExtra}
                  emptyBodyLabel={emptyBodyLabel}
                />
              </li>
            ))}
          </ul>
        ) : null)}
    </div>
  );

  const splitBody = (
    <div className="space-y-4">
      {config && entities.length > 0 && renderContext ? renderContext(config) : null}
      {stateContent ??
        (config ? (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
            {/* Left — a selectable list, stuck to the edge and sticky on scroll. */}
            <div className="lg:border-border/60 space-y-3 lg:sticky lg:top-0 lg:self-start lg:border-r lg:pr-4">
              {searchInput}
              {filtered.length === 0 ? (
                noMatches
              ) : (
                <ul className="space-y-0.5">
                  {filtered.map((entity) => {
                    const trailing = renderRowTrailing?.(entity, config);
                    const isActive = selected?.path === entity.path;
                    return (
                      <li key={entity.path}>
                        <button
                          type="button"
                          onClick={() => setSelectedPath(entity.path)}
                          aria-current={isActive}
                          className={cn(
                            'focus-visible:ring-kortix-blue flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
                            isActive
                              ? 'bg-secondary text-foreground font-medium'
                              : 'text-muted-foreground hover:bg-muted/50',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {renderTriggerLabel(entity)}
                          </span>
                          {trailing ? (
                            <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {/* Right — the selected entity (source in the middle, extras aside). */}
            <div className="min-w-0">
              {selected ? (
                <EntityDetail
                  key={selected.path}
                  projectId={projectId}
                  kind={kind}
                  entity={selected}
                  config={config}
                  renderDetailTitle={renderDetailTitle}
                  renderDetailMeta={renderDetailMeta}
                  renderDetailExtra={renderDetailExtra}
                  emptyBodyLabel={emptyBodyLabel}
                  split
                />
              ) : (
                <p className="text-muted-foreground/60 px-4 py-16 text-center text-sm">
                  Pick {noun === 'agent' ? 'an' : 'a'} {noun} on the left to preview it.
                </p>
              )}
            </div>
          </div>
        ) : null)}
    </div>
  );

  const body = layout === 'split' ? splitBody : accordionBody;

  return (
    <CustomizeSectionWrapper
      title={title}
      description={description}
      docs={docs}
      className={layout === 'split' ? 'max-w-none px-6' : undefined}
      action={
        <div className="flex items-center gap-1.5">
          <MarketplaceSectionButton projectId={projectId} />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => configure.start(newConfigPrompt(kind))}
            disabled={configure.pending}
          >
            {configure.pending ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <Plus className="size-4" />
            )}
            New
          </Button>
        </div>
      }
    >
      {body}
    </CustomizeSectionWrapper>
  );
}

function defaultMatches(entity: ConfigEntity, q: string) {
  return (
    entity.name.toLowerCase().includes(q) ||
    (entity.description?.toLowerCase().includes(q) ?? false)
  );
}

interface EntityDisclosureProps<T extends ConfigEntity> {
  projectId: string;
  kind: ConfigKind;
  entity: T;
  config: ProjectConfigSummary;
  triggerVariant: 'popover' | 'accent';
  renderTriggerLabel: (entity: T) => ReactNode;
  renderRowTrailing?: (entity: T, config: ProjectConfigSummary) => ReactNode;
  renderDetailTitle: (entity: T) => ReactNode;
  renderDetailMeta?: (entity: T, config: ProjectConfigSummary) => ReactNode;
  renderDetailExtra?: (entity: T, config: ProjectConfigSummary) => ReactNode;
  emptyBodyLabel: string;
}

function EntityDisclosure<T extends ConfigEntity>({
  projectId,
  kind,
  entity,
  config,
  triggerVariant,
  renderTriggerLabel,
  renderRowTrailing,
  renderDetailTitle,
  renderDetailMeta,
  renderDetailExtra,
  emptyBodyLabel,
}: EntityDisclosureProps<T>) {
  const [open, setOpen] = useState(false);
  const trailing = renderRowTrailing?.(entity, config);

  return (
    <Disclosure variant="outline" className="overflow-hidden" open={open} onOpenChange={setOpen}>
      <DisclosureTrigger variant="outline">
        <Button
          variant={triggerVariant}
          className={cn('flex w-full items-center justify-start gap-2 rounded-none')}
        >
          <span className="truncate text-sm font-medium">{renderTriggerLabel(entity)}</span>
          {trailing ? <span className="ml-auto flex items-center gap-1.5">{trailing}</span> : null}
        </Button>
      </DisclosureTrigger>
      <DisclosureContent variant="outline" contentClassName="border-border border-t">
        <EntityDetail
          projectId={projectId}
          kind={kind}
          entity={entity}
          config={config}
          renderDetailTitle={renderDetailTitle}
          renderDetailMeta={renderDetailMeta}
          renderDetailExtra={renderDetailExtra}
          emptyBodyLabel={emptyBodyLabel}
        />
      </DisclosureContent>
    </Disclosure>
  );
}

interface EntityDetailProps<T extends ConfigEntity> {
  projectId: string;
  kind: ConfigKind;
  entity: T;
  config: ProjectConfigSummary;
  renderDetailTitle: (entity: T) => ReactNode;
  renderDetailMeta?: (entity: T, config: ProjectConfigSummary) => ReactNode;
  renderDetailExtra?: (entity: T, config: ProjectConfigSummary) => ReactNode;
  emptyBodyLabel: string;
  /** Master-detail mode: render the source in the middle and `renderDetailExtra`
   *  as a right-hand aside, instead of stacking the extra above the source. */
  split?: boolean;
}

function EntityDetail<T extends ConfigEntity>({
  projectId,
  kind,
  entity,
  config,
  renderDetailTitle,
  renderDetailMeta,
  renderDetailExtra,
  emptyBodyLabel,
  split,
}: EntityDetailProps<T>) {
  const configure = useConfigureThread(projectId);
  const fileQuery = useQuery({
    queryKey: ['project-file-source', projectId, entity.path],
    queryFn: () => readProjectFile(projectId, entity.path),
    staleTime: 30_000,
  });

  const onCopy = async () => {
    if (!fileQuery.data?.content) return;
    try {
      await navigator.clipboard.writeText(fileQuery.data.content);
      successToast('Source copied');
    } catch {
      errorToast('Copy failed');
    }
  };

  const { body } = useMemo(
    () => splitFrontmatter(fileQuery.data?.content ?? ''),
    [fileQuery.data?.content],
  );

  const meta = renderDetailMeta?.(entity, config);
  const extra = renderDetailExtra?.(entity, config);

  const source = fileQuery.isLoading ? (
    <div className="space-y-2.5">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-10/12" />
      <Skeleton className="h-4 w-9/12" />
    </div>
  ) : fileQuery.isError ? (
    <InfoBanner
      tone="destructive"
      title="Couldn't load source"
      action={
        <Button variant="outline" size="sm" onClick={() => fileQuery.refetch()}>
          Retry
        </Button>
      }
    >
      {(fileQuery.error as Error)?.message ?? 'Failed to read source'}
    </InfoBanner>
  ) : body.trim() ? (
    <UnifiedMarkdown content={body} />
  ) : (
    <p className="text-muted-foreground/60 text-sm italic">{emptyBodyLabel}</p>
  );

  const header = (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-2">
        {meta ? <div className="flex flex-wrap items-center gap-1.5">{meta}</div> : null}
        <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
          {renderDetailTitle(entity)}
        </h1>
        {entity.description ? (
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed text-pretty">
            {entity.description}
          </p>
        ) : null}
        <p className="text-muted-foreground/50 truncate font-mono text-xs">{entity.path}</p>
      </div>
      <DetailToolbarActions
        onCopy={onCopy}
        onEdit={() => configure.start(editConfigPrompt(kind, entity.name, entity.path))}
        editing={configure.pending}
        copyDisabled={!fileQuery.data?.content}
      />
    </div>
  );

  if (split) {
    // Full-width master detail: the source (header + body) fills the MIDDLE with a
    // readable max-width, and the extra cards sit as a right-hand aside stuck to
    // the edge. Below xl the aside stacks under the source.
    return (
      <div
        className={cn(
          'grid grid-cols-1 gap-8 pb-10',
          extra && 'xl:grid-cols-[minmax(0,1fr)_340px]',
        )}
      >
        <div className="min-w-0">
          <div className="mx-auto max-w-3xl">
            {header}
            <div className="mt-8">{source}</div>
          </div>
        </div>
        {extra ? (
          <aside className="space-y-3 xl:sticky xl:top-0 xl:self-start xl:pt-1">{extra}</aside>
        ) : null}
      </div>
    );
  }

  return (
    <div className="px-4 py-5">
      {header}
      {extra ? <div className="mt-6">{extra}</div> : null}
      <div className="mt-8">{source}</div>
    </div>
  );
}

function DetailToolbarActions({
  onCopy,
  onEdit,
  editing,
  copyDisabled,
}: {
  onCopy: () => void;
  onEdit: () => void;
  editing: boolean;
  copyDisabled: boolean;
}) {
  return (
    <ButtonGroup className="shrink-0">
      <Hint label="Edit">
        <Button variant="outline" size="sm" onClick={onEdit} disabled={editing}>
          {editing ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <Pencil className="size-3.5 shrink-0" />
          )}
          Edit
        </Button>
      </Hint>
      <Hint label="Copy source">
        <Button variant="outline" size="icon" onClick={onCopy} disabled={copyDisabled}>
          <Copy className="size-3.5 shrink-0" />
        </Button>
      </Hint>
    </ButtonGroup>
  );
}
