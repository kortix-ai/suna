'use client';

import { createProjectSession, type ArtifactDetail, type ArtifactVersion } from '@kortix/sdk';
import { useArtifact, useArtifactMutations, useArtifactVersions } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { ErrorState } from '@kortix/ui/error-state';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { successToast } from '@kortix/ui/toast';
import { SidebarToggle } from '@kortix/ui/workspace';
import {
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ClockCounterClockwiseIcon,
  CornersOutIcon,
  DotsThreeIcon,
  FilePdfIcon,
  FolderOpenIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShareNetworkIcon,
  SparkleIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { drivePathToParam } from '@/features/drives/drive-path-param';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { ARTIFACT_TYPE_ICON, ArtifactFrame, VISIBILITY_ICON, relativeTime, useStableViewUrl } from './artifact-meta';
import { DocEditor, type DocSaveStatus } from './doc-editor';
import { ShareArtifactDialog } from './share-artifact-dialog';

/** Saves closer than this show as one row of the history: an editing burst. */
const BURST_MS = 5 * 60_000;

/** The history as people read it: each burst of saves (autosave) is one row, its newest save. */
function historyRows(versions: ArtifactVersion[]): Array<ArtifactVersion & { saves: number }> {
  const rows: Array<ArtifactVersion & { saves: number }> = [];
  versions.forEach((v, i) => {
    const newer = versions[i - 1];
    const row = rows.at(-1);
    if (row && newer && Date.parse(newer.created_at) - Date.parse(v.created_at) <= BURST_MS) row.saves += 1;
    else rows.push({ ...v, saves: 1 });
  });
  return rows;
}

/** The first prompt of a session that changes an artifact. Agent-facing, so English. */
function editArtifactPrompt(a: ArtifactDetail, change: string): string {
  return [
    `Update the Kortix artifact "${a.title}" (id ${a.artifact_id}). Its files are in Files at ${a.path}.`,
    `Edit them there (or \`kortix artifacts pull ${a.artifact_id} ./artifact\`, then \`kortix artifacts publish ./artifact --id ${a.artifact_id}\`), and reply with its link.`,
    '',
    change.trim(),
  ].join('\n');
}

/**
 * /projects/[id]/artifacts/[artifactId] — one artifact, full height. A doc is
 * its Markdown file in the doc editor (read-only without write access in
 * Files); an HTML page runs in a sandboxed frame. The history is the Files
 * commit log of its path.
 */
export function ArtifactViewer({ projectId, artifactId }: { projectId: string; artifactId: string }) {
  const t = useTranslations('artifacts');
  const locale = useLocale();
  const router = useRouter();
  const [version, setVersion] = useState<string | undefined>(undefined);
  const query = useArtifact(projectId, artifactId, version);
  const artifact = query.data;
  const mutations = useArtifactMutations(projectId);
  const frame = useRef<HTMLIFrameElement>(null);
  const [docStatus, setDocStatus] = useState<DocSaveStatus>('saved');
  const [sharing, setSharing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const versions = useArtifactVersions(projectId, artifactId, historyOpen);
  const viewUrl = useStableViewUrl(artifact ? `${artifact.artifact_id}:${artifact.version.id ?? 'now'}` : null, artifact?.version.view_url);
  const viewingOld = !!artifact?.version.id;
  const canEdit = !!artifact?.can_edit && !viewingOld;
  const isDoc = artifact?.type === 'doc';

  if (query.isError) {
    return (
      <div className="mx-auto w-full max-w-3xl p-8">
        <ErrorState
          title={t('notFoundTitle')}
          description={t('notFoundHint')}
          action={
            <Button size="sm" variant="outline" asChild>
              <Link href={`/projects/${projectId}/artifacts`}>{t('back')}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const TypeIcon = artifact ? ARTIFACT_TYPE_ICON[artifact.type] : null;
  const VisIcon = artifact ? VISIBILITY_ICON[artifact.visibility] : null;
  const statusText = isDoc && canEdit && docStatus !== 'saved' ? t(`docStatus.${docStatus}`) : null;
  const folder = artifact ? (artifact.path.endsWith(`/${artifact.entry}`) ? artifact.path.slice(0, -artifact.entry.length - 1) : artifact.path) : '';
  const rows = historyRows(versions.data ?? []);

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <header className="kx-titlebar-row kx-capability-titlebar flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <SidebarToggle />
        <Button size="icon-sm" variant="ghost" asChild aria-label={t('back')}>
          <Link href={`/projects/${projectId}/artifacts`}>
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          {TypeIcon ? <TypeIcon className="text-muted-foreground size-4 shrink-0" /> : null}
          {artifact ? (
            renaming ? (
              <input
                autoFocus
                defaultValue={artifact.title}
                aria-label={t('rename')}
                className="bg-transparent text-sm font-medium outline-none"
                onBlur={() => setRenaming(false)}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') setRenaming(false);
                  if (e.key === 'Enter') {
                    const title = e.currentTarget.value.trim();
                    setRenaming(false);
                    if (title && title !== artifact.title) await mutations.update.mutateAsync({ artifactId: artifact.artifact_id, title });
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="hover:bg-accent truncate rounded-sm px-1 text-sm font-medium disabled:hover:bg-transparent"
                disabled={!artifact.can_manage}
                onClick={() => setRenaming(true)}
              >
                {artifact.title}
              </button>
            )
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
          {artifact && VisIcon ? (
            <span className="text-muted-foreground hidden shrink-0 items-center gap-1 text-xs sm:flex">
              <VisIcon className="size-3.5" />
              {t(`visibility.${artifact.visibility}`)}
            </span>
          ) : null}
        </div>

        {artifact ? (
          <div className="flex shrink-0 items-center gap-1">
            {statusText ? <span className="text-muted-foreground px-2 text-xs">{statusText}</span> : null}
            <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="text-muted-foreground font-normal">
                  <ClockCounterClockwiseIcon />
                  <span className="hidden md:inline">{relativeTime(artifact.updated_at, locale)}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
                <DropdownMenuLabel>{t('history')}</DropdownMenuLabel>
                {versions.isLoading ? (
                  <div className="flex flex-col gap-2 p-2">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : rows.length === 0 ? (
                  <p className="text-muted-foreground px-2 py-3 text-xs">{t('historyEmpty')}</p>
                ) : (
                  rows.map((v, i) => (
                    <DropdownMenuItem
                      key={v.id}
                      onSelect={() => setVersion(i === 0 ? undefined : v.id)}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v.created_at))}</span>
                        <span className="text-muted-foreground text-xs">
                          {relativeTime(v.created_at, locale)}
                          {v.saves > 1 ? ` · ${t('saves', { count: v.saves })}` : ''}
                        </span>
                      </span>
                      {i === 0 ? <span className="text-muted-foreground text-xs">{t('current')}</span> : null}
                      {version === v.id ? <span className="text-xs">{t('viewing')}</span> : null}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {canEdit ? (
              <Button size="sm" variant="ghost" onClick={() => setAsking(true)} className="hidden sm:inline-flex">
                <SparkleIcon /> {t('askAgent')}
              </Button>
            ) : null}
            {artifact.can_manage ? (
              <Button size="sm" variant="secondary" onClick={() => setSharing(true)}>
                <ShareNetworkIcon /> {t('share')}
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('actions')}>
                  <DotsThreeIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isDoc ? (
                  <DropdownMenuItem onSelect={() => window.open(`${artifact.version.view_url}?print=1`, '_blank', 'noopener')}>
                    <FilePdfIcon /> {t('exportPdf')}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => frame.current?.requestFullscreen?.()}>
                    <CornersOutIcon /> {t('fullScreen')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => window.open(artifact.version.view_url, '_blank', 'noopener')}>
                  <ArrowSquareOutIcon /> {t('openNewTab')}
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/projects/${projectId}/drive?path=${encodeURIComponent(drivePathToParam(folder, null))}`}>
                    <FolderOpenIcon /> {t('openInFiles')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => mutations.pin.mutate({ artifactId: artifact.artifact_id, pinned: !artifact.pinned })}>
                  {artifact.pinned ? <PushPinSlashIcon /> : <PushPinIcon />} {artifact.pinned ? t('unpin') : t('pin')}
                </DropdownMenuItem>
                {artifact.can_manage ? (
                  <>
                    <DropdownMenuItem onSelect={() => setRenaming(true)}>
                      <PencilSimpleIcon /> {t('rename')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
                      <XCircleIcon /> {t('remove')}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </header>

      {artifact && viewingOld ? (
        <div className="bg-muted flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs">
          <span>{t('viewingOld', { time: relativeTime(rows.find((r) => r.id === version)?.created_at ?? artifact.updated_at, locale) })}</span>
          <span className="flex gap-1">
            <Button size="xs" variant="ghost" onClick={() => setVersion(undefined)}>
              {t('backToCurrent')}
            </Button>
            {artifact.can_edit ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={mutations.restore.isPending}
                onClick={async () => {
                  await mutations.restore.mutateAsync({ artifactId: artifact.artifact_id, version: version! });
                  setVersion(undefined);
                  successToast(t('restored'));
                }}
              >
                <ArrowCounterClockwiseIcon /> {t('restore')}
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {!artifact ? (
          <Skeleton className="m-4 flex-1 rounded-md" />
        ) : isDoc ? (
          <div className="bg-background min-w-0 flex-1 overflow-y-auto">
            <DocEditor
              key={`${artifact.artifact_id}:${artifact.version.id ?? 'now'}`}
              projectId={projectId}
              artifact={artifact}
              editable={canEdit}
              onStatus={setDocStatus}
            />
          </div>
        ) : (
          <div className="bg-muted relative min-w-0 flex-1">
            {viewUrl ? (
              <ArtifactFrame ref={frame} key={viewUrl} src={viewUrl} title={artifact.title} className="absolute inset-0 size-full border-0" />
            ) : null}
          </div>
        )}
      </div>

      {artifact && sharing ? <ShareArtifactDialog projectId={projectId} artifact={artifact} open onOpenChange={setSharing} /> : null}
      {artifact ? <AskAgentDialog projectId={projectId} artifact={artifact} open={asking} onOpenChange={setAsking} /> : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('removeTitle')}
        description={t('removeHint')}
        confirmLabel={t('remove')}
        confirmVariant="destructive"
        isPending={mutations.remove.isPending}
        onConfirm={async () => {
          await mutations.remove.mutateAsync(artifactId);
          successToast(t('removed'));
          router.push(`/projects/${projectId}/artifacts`);
        }}
      />
    </div>
  );
}

function AskAgentDialog({
  projectId,
  artifact,
  open,
  onOpenChange,
}: {
  projectId: string;
  artifact: ArtifactDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('artifacts');
  const router = useRouter();
  const [change, setChange] = useState('');
  const [starting, setStarting] = useState(false);
  const start = async () => {
    if (!change.trim()) return;
    setStarting(true);
    try {
      const session = await createProjectSession(projectId, { initial_prompt: editArtifactPrompt(artifact, change) });
      // nav-contract: prefetch-only — the session id exists only after the create call returns.
      router.push(`/projects/${projectId}/sessions/${session.session_id}`);
    } finally {
      setStarting(false);
    }
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('askAgentTitle')}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <Textarea
            autoFocus
            value={change}
            onChange={(e) => setChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start();
            }}
            placeholder={t('askAgentPlaceholder')}
            aria-label={t('askAgentPlaceholder')}
            className="min-h-28"
          />
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={start} disabled={!change.trim() || starting}>
            <SparkleIcon /> {t('askAgentSend')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
