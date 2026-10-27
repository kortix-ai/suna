'use client';

import {
  bindingSpace,
  PROJECT_WIDE_SPACE,
  groupBySpace,
  listSpaces,
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
import { Input } from '@kortix/ui/input';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { errorToast, successToast } from '@kortix/ui/toast';
import { ALL_SPACES, ProjectPageHeader, SpaceFilterTabs, spaceFilterLabel, useSpaceFilter } from '@kortix/ui/workspace';
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
import { useState } from 'react';

import { ArtifactFrame, artifactFrameKey } from '@kortix/ui/artifacts';

import { useLocale, useTranslations } from '@/i18n/use-translations';

import {
  ARTIFACT_TYPE_ICON,
  VISIBILITY_ICON,
  artifactHref,
  relativeTime,
} from './artifact-meta';
import { ShareArtifactDialog } from './share-artifact-dialog';

const SCOPES: ArtifactListScope[] = ['all', 'mine', 'shared', 'pinned'];

/**
 * /projects/[id]/artifacts — every artifact the viewer may see, as live
 * previews, and a New doc button.
 */
export function ArtifactsGallery({ projectId }: { projectId: string }) {
  const t = useTranslations('artifacts');
  const [scope, setScope] = useState<ArtifactListScope>('all');
  const [q, setQ] = useState('');
  const router = useRouter();
  const { create } = useArtifactMutations(projectId);
  const newDoc = async () => {
    const a = await create.mutateAsync({ files: { 'index.md': { content: `# ${t('untitledDoc')}\n\n` } } });
    router.push(artifactHref(projectId, a.artifact_id));
  };
  const list = useArtifacts(projectId, { scope, q: q.trim() || undefined });
  // An artifact sits in its bound space, else its agent's space, else Project-wide.
  const config = useProjectConfig(projectId);
  const agents = config?.agents ?? [];
  const spaceOf = (artifact: Artifact) => bindingSpace(artifact, agents) ?? PROJECT_WIDE_SPACE;
  const groups = groupBySpace(list.data ?? [], config?.spaces, spaceOf);
  const labels = new Map(groups.map((group) => [group.name, group.label]));
  const [space, setSpace] = useSpaceFilter(projectId);
  const spaces = listSpaces(config);
  const items = (list.data ?? []).filter((artifact) => space === ALL_SPACES || spaceOf(artifact) === space);

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')}>
        <Button size="sm" variant="ghost" onClick={newDoc} disabled={create.isPending}>
          <PlusIcon /> {t('newDoc')}
        </Button>
      </ProjectPageHeader>
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
                <div className="relative w-full sm:w-64">
                  <MagnifyingGlassIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} aria-label={t('search')} className="h-8 pl-8" />
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="aspect-[4/3] w-full rounded-lg" />
                ))}
              </div>
            ) : items.length === 0 ? (
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((artifact) => (
                  <ArtifactCard
                    key={artifact.artifact_id}
                    projectId={projectId}
                    artifact={artifact}
                    space={space === ALL_SPACES ? labels.get(spaceOf(artifact)) : undefined}
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

function ArtifactCard({
  projectId,
  artifact,
  space,
  current,
  spaces,
}: {
  projectId: string;
  artifact: Artifact;
  /** The space chip: only while every space is shown. */
  space?: string;
  /** The space the artifact resolves to now (`PROJECT_WIDE_SPACE`: project-wide). */
  current: string;
  /** Where "Move to space" can bind it. */
  spaces: ManifestSpace[];
}) {
  const t = useTranslations('artifacts');
  const locale = useLocale();
  const mutations = useArtifactMutations(projectId);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const TypeIcon = ARTIFACT_TYPE_ICON[artifact.type];
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
    <div className="group bg-card hover:border-foreground/20 relative flex flex-col overflow-hidden rounded-lg border transition-colors">
      <Link
        href={href}
        className="focus-visible:ring-ring flex flex-col outline-none focus-visible:ring-2"
        aria-label={artifact.title}
        // Warm the viewer's reads before the click lands.
        onPointerEnter={warm}
        onFocus={warm}
      >
        <div className="bg-muted relative aspect-[16/10] overflow-hidden border-b">
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
        <div className="flex items-center gap-3 p-3">
          <span className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-md">
            <TypeIcon className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{artifact.title}</span>
            <span className="text-muted-foreground truncate text-xs">
              {t('updated', { time: relativeTime(artifact.updated_at, locale) })}
              {space ? ` · ${space}` : null}
            </span>
          </span>
          {artifact.pinned ? <PushPinIcon className="text-muted-foreground size-3.5 shrink-0" aria-label={t('pinned')} /> : null}
          <VisIcon className="text-muted-foreground size-3.5 shrink-0" aria-label={t(`visibility.${artifact.visibility}`)} />
        </div>
      </Link>
      <div className="absolute top-2 right-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="secondary" aria-label={t('actions')}>
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
}
