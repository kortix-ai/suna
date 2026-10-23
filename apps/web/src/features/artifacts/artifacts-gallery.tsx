'use client';

import type { Artifact, ArtifactListScope, ArtifactType } from '@kortix/sdk';
import { useArtifactMutations, useArtifacts } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { Input } from '@kortix/ui/input';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { successToast } from '@kortix/ui/toast';
import { ProjectPageHeader } from '@kortix/ui/workspace';
import {
  ArrowSquareOutIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShareNetworkIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';

import {
  ARTIFACT_TYPE_ICON,
  ArtifactFrame,
  CREATE_TYPES,
  VISIBILITY_ICON,
  artifactHref,
  relativeTime,
  useStableViewUrl,
} from './artifact-meta';
import { NewArtifactDialog } from './new-artifact-dialog';
import { ShareArtifactDialog } from './share-artifact-dialog';

const SCOPES: ArtifactListScope[] = ['all', 'mine', 'shared', 'pinned'];

/**
 * /projects/[id]/artifacts — the gallery: make a new doc or HTML page, and
 * every artifact the viewer may see, as live previews.
 */
export function ArtifactsGallery({ projectId }: { projectId: string }) {
  const t = useTranslations('artifacts');
  const [scope, setScope] = useState<ArtifactListScope>('all');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState<ArtifactType | null>(null);
  const list = useArtifacts(projectId, { scope, q: q.trim() || undefined });
  const items = list.data ?? [];

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 pb-20 md:px-8">
          <section className="flex flex-col gap-3">
            <h2 className="text-muted-foreground text-xs font-medium">{t('makeNew')}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CREATE_TYPES.map((type) => {
                const TypeIcon = ARTIFACT_TYPE_ICON[type];
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setCreating(type)}
                    className="group bg-card hover:bg-accent focus-visible:ring-ring flex flex-col items-start gap-6 rounded-lg border p-4 text-left transition-colors outline-none focus-visible:ring-2"
                  >
                    <span className="bg-background text-foreground grid size-10 place-items-center rounded-md border transition-transform group-hover:-translate-y-0.5">
                      <TypeIcon className="size-5" />
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{t(`type.${type}`)}</span>
                      <span className="text-muted-foreground line-clamp-2 text-xs">{t(`typeHint.${type}`)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-4">
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
                title={q || scope !== 'all' ? t('emptyFiltered') : t('empty')}
                description={q || scope !== 'all' ? undefined : t('emptyHint')}
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((artifact) => (
                  <ArtifactCard key={artifact.artifact_id} projectId={projectId} artifact={artifact} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      <NewArtifactDialog projectId={projectId} type={creating} onOpenChange={(open) => !open && setCreating(null)} />
    </div>
  );
}

function ArtifactCard({ projectId, artifact }: { projectId: string; artifact: Artifact }) {
  const t = useTranslations('artifacts');
  const locale = useLocale();
  const mutations = useArtifactMutations(projectId);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const TypeIcon = ARTIFACT_TYPE_ICON[artifact.type];
  const VisIcon = VISIBILITY_ICON[artifact.visibility];
  const href = artifactHref(projectId, artifact.artifact_id);
  const viewUrl = useStableViewUrl(`${artifact.artifact_id}:${artifact.current_version}`, artifact.view_url);

  return (
    <div className="group bg-card hover:border-foreground/20 relative flex flex-col overflow-hidden rounded-lg border transition-colors">
      <Link href={href} className="focus-visible:ring-ring flex flex-col outline-none focus-visible:ring-2" aria-label={artifact.title}>
        <div className="bg-muted relative aspect-[16/10] overflow-hidden border-b">
          {viewUrl ? (
            <ArtifactFrame
              preview
              src={viewUrl}
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
            {artifact.can_edit ? (
              <>
                <DropdownMenuItem onSelect={() => setSharing(true)}>
                  <ShareNetworkIcon /> {t('share')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                  <TrashIcon /> {t('delete')}
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
        title={t('deleteTitle')}
        description={t('deleteHint')}
        confirmLabel={t('delete')}
        confirmVariant="destructive"
        isPending={mutations.remove.isPending}
        onConfirm={async () => {
          await mutations.remove.mutateAsync(artifact.artifact_id);
          setDeleting(false);
          successToast(t('deleted'));
        }}
      />
    </div>
  );
}
