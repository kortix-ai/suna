'use client';

import {
  PROJECT_WIDE_SPACE,
  type Artifact,
  type ArtifactListScope,
  type ManifestSpace,
} from '@kortix/sdk';
import { prefetchArtifact, useArtifactMutations, useArtifacts, useProjectConfig } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { useSlashFocus } from '@kortix/ui/internal/hooks/use-slash-focus';
import { InputGroupSearch, InputGroupSearchClear, InputGroupSearchIcon, InputGroupSearchInput } from '@kortix/ui/input-group';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { errorToast, successToast } from '@kortix/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@kortix/ui/tooltip';
import {
  ALL_SPACES,
  ProjectPageHeader,
  SpaceFilterTabs,
  spaceFilterLabel,
  spaceScope,
  useSpaceFilter,
  useSpacesEnabled,
} from '@kortix/ui/workspace';
import {
  ArrowSquareOutIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShareNetworkIcon,
  StackSimpleIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { memo, useEffect, useRef, useState } from 'react';

import { ArtifactFrame, artifactFrameKey } from '@kortix/ui/artifacts';

import { useAuth } from '@/features/providers/auth-provider';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import {
  VISIBILITY_ICON,
  artifactHref,
  relativeTime,
} from './artifact-meta';
import { ShareArtifactDialog } from './share-artifact-dialog';

const SCOPES: ArtifactListScope[] = ['all', 'mine', 'shared', 'pinned'];

/** The list route's default page: a project with this many may hold more than the list shows. */
const LIST_PAGE = 100;

/** The list route's own filters (`listArtifacts` in the API), applied in the browser. */
function matches(a: Artifact, scope: ArtifactListScope, q: string, viewerId: string | undefined): boolean {
  if (scope === 'mine' && a.created_by.user_id !== viewerId) return false;
  if (scope === 'shared' && a.created_by.user_id === viewerId) return false;
  if (scope === 'pinned' && !a.pinned) return false;
  return !q || a.title.toLowerCase().includes(q) || !!a.description?.toLowerCase().includes(q);
}

/**
 * /projects/[id]/artifacts — every artifact the viewer may see, as live
 * previews, and a New doc button after the search (the Skills page's pair).
 * A new doc joins the grid where you are; its toast opens it.
 */
export function ArtifactsGallery({ projectId }: { projectId: string }) {
  const t = useTranslations('artifacts');
  const [scope, setScope] = useState<ArtifactListScope>('all');
  const [q, setQ] = useState('');
  // As on Skills: the search is focused on arrival (desktop), and "/" jumps back to it.
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const grid = useColumnWidth();
  const router = useRouter();
  const { create } = useArtifactMutations(projectId);
  const newDoc = async () => {
    const a = await create.mutateAsync({ files: { 'index.md': { content: `# ${t('untitledDoc')}\n\n` } } });
    successToast(t('docCreated'), { actions: [{ label: t('open'), onClick: () => router.push(artifactHref(projectId, a.artifact_id)) }] });
  };
  // One list, filtered here: a tab or a search changes what shows, not what is mounted, so no
  // card (or its live preview) remounts. A project at the list's page size may hold more than
  // it shows: there a filter asks the server.
  const viewerId = useAuth().user?.id;
  const query = q.trim().toLowerCase();
  const filtered = scope !== 'all' || !!query;
  const all = useArtifacts(projectId, { scope: 'all' });
  const paged = (all.data?.length ?? 0) >= LIST_PAGE;
  const server = useArtifacts(paged && filtered ? projectId : null, { scope, q: query || undefined });
  const list = paged && filtered ? server : all;
  const cards = list.data ?? [];
  // An artifact sits in its bound space, else its agent's space, else Project-wide.
  // Spaces are Work in progress: with `project_channels` off every artifact is
  // project-wide, and the page shows no filter, chip or "Move to space".
  const config = useProjectConfig(projectId);
  const spacesOn = useSpacesEnabled(projectId);
  const { spaces, groups, spaceOf } = spaceScope(cards, config, spacesOn, (artifact) => artifact);
  const labels = new Map(groups.map((group) => [group.name, group.label]));
  const [space, setSpace] = useSpaceFilter(projectId);
  const shown = (paged ? cards : cards.filter((a) => matches(a, scope, query, viewerId))).filter(
    (artifact) => space === ALL_SPACES || spaceOf(artifact) === space,
  );

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 pb-20 md:px-8">
          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs value={scope} onValueChange={(v) => setScope(v as ArtifactListScope)}>
                  <TabsList variant="segmented">
                    {SCOPES.map((s) => (
                      <TabsTrigger key={s} value={s}>
                        {t(`scope.${s}`)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                {/* Search, then New: the Skills page's pair (an h-9 search and a secondary h-9 button). */}
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <InputGroupSearch className="min-w-0 flex-1 sm:w-64 sm:flex-none">
                    <InputGroupSearchIcon>
                      <MagnifyingGlassIcon />
                    </InputGroupSearchIcon>
                    <InputGroupSearchInput
                      ref={searchRef}
                      placeholder={t('search')}
                      aria-label={t('search')}
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      variant="popover"
                      size="sm"
                    />
                    <InputGroupSearchClear onClick={() => setQ('')} />
                  </InputGroupSearch>
                  <Button variant="secondary" className="shrink-0 gap-1.5" onClick={newDoc} disabled={create.isPending} aria-busy={create.isPending}>
                    {create.isPending ? <Loading className="size-4 shrink-0" /> : <PlusIcon className="size-4" />}
                    {t('newDoc')}
                  </Button>
                </div>
              </div>
              <SpaceFilterTabs spaces={spaces} groups={groups} value={space} onValueChange={setSpace} />
            </div>

            {list.isError ? (
              <ErrorState
                title={t('loadError')}
                action={
                  <Button size="sm" variant="outline" onClick={() => list.refetch()}>
                    {t('retry')}
                  </Button>
                }
              />
            ) : list.isLoading ? (
              <div className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="aspect-[16/10] w-full rounded-lg" />
                ))}
              </div>
            ) : shown.length === 0 && !create.isPending ? (
              <EmptyState
                title={
                  q || scope !== 'all'
                    ? t('emptyFiltered')
                    : space !== ALL_SPACES
                      ? t('spaceEmpty', { space: spaceFilterLabel(space, spaces, t('projectWide')) })
                      : t('empty')
                }
                description={q || scope !== 'all' || space !== ALL_SPACES ? undefined : t('emptyHint')}
                action={
                  space !== ALL_SPACES ? (
                    <Button size="sm" variant="outline" onClick={() => setSpace(ALL_SPACES)}>
                      {t('showAll')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div ref={grid} className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
                {/* The new doc while the server writes it: the click shows at once, then the page opens. */}
                {create.isPending ? <CreatingCard /> : null}
                {cards.map((artifact) => (
                  <ArtifactCard
                    key={artifact.artifact_id}
                    projectId={projectId}
                    artifact={artifact}
                    hidden={!shown.includes(artifact)}
                    space={spacesOn && space === ALL_SPACES ? labels.get(spaceOf(artifact)) : undefined}
                    current={spaceOf(artifact)}
                    spaces={spaces}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * The grid's column width as `--card-w` on the grid: a card the tab or search
 * leaves out keeps exactly that width, so showing it again does not resize its
 * preview (a resized frame lays its page out again, and paints it half done).
 */
function useColumnWidth() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const first = Number.parseFloat(getComputedStyle(node).gridTemplateColumns.split(' ')[0] ?? '');
      if (first > 0) node.style.setProperty('--card-w', `${first}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  });
  return ref;
}

/** A card is the rounded preview, then a plain line under it: the name, "Updated … · visibility", the actions. */
// No position here: a shown card is `relative` (its link's ::after covers it), a filtered-out one `fixed`.
const CARD = 'group flex flex-col gap-2.5';
const CARD_PREVIEW =
  'bg-background group-hover:border-foreground/20 group-focus-within:border-foreground/20 relative aspect-[16/10] overflow-hidden rounded-lg border transition-colors';
const CARD_FOOTER = 'flex items-start gap-2 px-0.5';

function CreatingCard() {
  const t = useTranslations('artifacts');
  return (
    <div className={`${CARD} relative`} aria-busy>
      <div className={`${CARD_PREVIEW} grid place-items-center`}>
        <Loading />
      </div>
      <div className={CARD_FOOTER}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{t('untitledDoc')}</span>
          <span className="text-muted-foreground truncate text-xs">{t('creating')}</span>
        </span>
      </div>
    </div>
  );
}

/** Memoized: a tab, a search or another card's change does not re-render it (the list keeps each artifact's identity). */
const ArtifactCard = memo(function ArtifactCard({
  projectId,
  artifact,
  hidden,
  space,
  current,
  spaces,
}: {
  projectId: string;
  artifact: Artifact;
  hidden?: boolean;
  /** The space chip: only while every space is shown. */
  space?: string;
  /** The space the artifact resolves to now (`PROJECT_WIDE_SPACE`: project-wide). */
  current: string;
  /** Where "Move to space" can bind it. Empty (spaces off, or none): no menu. */
  spaces: ManifestSpace[];
}) {
  const t = useTranslations('artifacts');
  const locale = useLocale();
  const mutations = useArtifactMutations(projectId);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const VisIcon = VISIBILITY_ICON[artifact.visibility];
  const href = artifactHref(projectId, artifact.artifact_id);
  const queryClient = useQueryClient();
  const warm = () => void prefetchArtifact(queryClient, projectId, artifact.artifact_id).catch(() => {});
  // Grouping only. A space keeps the owning agent; Project-wide clears both,
  // or the agent's own space would still claim the artifact.
  const moveTo = (target: string | null) =>
    mutations.update.mutate(
      { artifactId: artifact.artifact_id, space: target, ...(target === null ? { agent: null } : {}) },
      { onSuccess: () => successToast(t('moved')), onError: () => errorToast(t('moveFailed')) },
    );

  return (
    // A card the tab or search leaves out stays laid out at the column's width (`--card-w`), fixed
    // behind the page (no grid cell, no scroll height), invisible and inert. Not `display: none`:
    // its frame would lose its layout, and a different width would make showing it again resize
    // the frame; both paint the page half done for a frame.
    <div
      className={hidden ? `${CARD} pointer-events-none fixed top-0 left-0 -z-10 w-(--card-w) opacity-0` : `${CARD} relative`}
      inert={hidden}
      aria-hidden={hidden || undefined}
    >
      <div className={CARD_PREVIEW}>
        {artifact.view_url ? (
          <ArtifactFrame
            frameKey={artifactFrameKey(artifact)}
            preview
            src={artifact.view_url}
            title={artifact.title}
            className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-25 border-0"
          />
        ) : null}
      </div>
      <div className={CARD_FOOTER}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* The whole card is this link (its ::after covers the card); the actions sit above it. */}
          <Link
            href={href}
            className="truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
            // Warm the viewer's reads before the click lands.
            onPointerEnter={warm}
            onFocus={warm}
          >
            {artifact.title}
          </Link>
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <span className="truncate">
              {t('updated', { time: relativeTime(artifact.updated_at, locale) })}
              {space ? ` · ${space}` : null}
            </span>
            <span aria-hidden>·</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="relative z-10 flex shrink-0" aria-label={t(`visibility.${artifact.visibility}`)}>
                  <VisIcon weight="fill" className="size-3.5" aria-hidden />
                </span>
              </TooltipTrigger>
              <TooltipContent>{t(`visibility.${artifact.visibility}`)}</TooltipContent>
            </Tooltip>
            {artifact.pinned ? <PushPinIcon weight="fill" className="size-3.5 shrink-0" aria-label={t('pinned')} /> : null}
          </span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t('actions')} className="text-muted-foreground relative z-10 -mt-0.5 -mr-1.5 shrink-0">
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => window.open(artifact.view_url, '_blank', 'noopener')}>
              <ArrowSquareOutIcon /> {t('openNewTab')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => mutations.pin.mutate({ artifactId: artifact.artifact_id, pinned: !artifact.pinned })}>
              {artifact.pinned ? <PushPinSlashIcon /> : <PushPinIcon />} {artifact.pinned ? t('unpin') : t('pin')}
            </DropdownMenuItem>
            {artifact.can_manage ? (
              <>
                <DropdownMenuItem onSelect={() => setSharing(true)}>
                  <ShareNetworkIcon /> {t('share')}
                </DropdownMenuItem>
                {spaces.length ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <StackSimpleIcon /> {t('moveTo')}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={current}
                        onValueChange={(next) => {
                          if (next !== current) moveTo(next === PROJECT_WIDE_SPACE ? null : next);
                        }}
                      >
                        {spaces.map((target) => (
                          <DropdownMenuRadioItem key={target.name} value={target.name}>
                            {target.label || target.name}
                          </DropdownMenuRadioItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuRadioItem value={PROJECT_WIDE_SPACE}>{t('projectWide')}</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                  <XCircleIcon /> {t('remove')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {sharing ? <ShareArtifactDialog projectId={projectId} artifact={artifact} open onOpenChange={setSharing} /> : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('removeTitle')}
        description={t('removeHint')}
        confirmLabel={t('remove')}
        confirmVariant="destructive"
        isPending={mutations.remove.isPending}
        onConfirm={async () => {
          await mutations.remove.mutateAsync(artifact.artifact_id);
          setDeleting(false);
          successToast(t('removed'));
        }}
      />
    </div>
  );
});
