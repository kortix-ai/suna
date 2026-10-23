'use client';

import { createProjectSession, readArtifactFile, type ArtifactDetail } from '@kortix/sdk';
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
import { CodeEditor } from '@kortix/ui/files';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { SidebarToggle } from '@kortix/ui/workspace';
import {
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CodeIcon,
  CornersOutIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FilePdfIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShareNetworkIcon,
  SparkleIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';

import { ARTIFACT_TYPE_ICON, ArtifactFrame, VISIBILITY_ICON, relativeTime, useStableViewUrl } from './artifact-meta';
import { DocEditor, type DocSaveStatus } from './doc-editor';
import { ShareArtifactDialog } from './share-artifact-dialog';

/** The first prompt of a session that changes an artifact. Agent-facing, so English. */
function editArtifactPrompt(a: ArtifactDetail, change: string): string {
  return [
    `Update the Kortix artifact "${a.title}" (id ${a.artifact_id}, a ${a.type}, now at version ${a.current_version}).`,
    `Pull it with \`kortix artifacts pull ${a.artifact_id} ./artifact\`, make the change, publish it with \`kortix artifacts publish ./artifact --id ${a.artifact_id} --base-version ${a.current_version}\`, and reply with its link.`,
    '',
    change.trim(),
  ].join('\n');
}

/**
 * /projects/[id]/artifacts/[artifactId] — one artifact, full height. A doc is
 * the doc editor itself (read-only for viewers); an HTML page runs in a
 * sandboxed frame, with its code beside it while editing. Versions, Share,
 * Ask agent and Download PDF sit in the header.
 */
export function ArtifactViewer({ projectId, artifactId }: { projectId: string; artifactId: string }) {
  const t = useTranslations('artifacts');
  const locale = useLocale();
  const router = useRouter();
  const search = useSearchParams();
  const [version, setVersion] = useState<number | undefined>(undefined);
  const query = useArtifact(projectId, artifactId, version);
  const artifact = query.data;
  const mutations = useArtifactMutations(projectId);
  const frame = useRef<HTMLIFrameElement>(null);
  const [coding, setCoding] = useState(search.get('code') === '1');
  const [docStatus, setDocStatus] = useState<DocSaveStatus>('saved');
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const versions = useArtifactVersions(projectId, artifactId, versionsOpen);
  const viewUrl = useStableViewUrl(artifact ? `${artifact.artifact_id}:${artifact.version.version}` : null, artifact?.version.view_url);
  const viewingOld = artifact ? artifact.version.version !== artifact.current_version : false;
  const canEdit = !!artifact?.can_edit && !viewingOld;
  const isDoc = artifact?.type === 'doc';

  const download = async () => {
    if (!artifact) return;
    const blob = await readArtifactFile(projectId, artifact.artifact_id, { version: artifact.version.version });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([blob], { type: 'text/html' }));
    a.download = `${artifact.title.replace(/[^\w.-]+/g, '-').slice(0, 80) || 'artifact'}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

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
                disabled={!artifact.can_edit}
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
            <DropdownMenu open={versionsOpen} onOpenChange={setVersionsOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="text-muted-foreground hidden font-normal md:inline-flex">
                  {t('versionShort', { version: artifact.version.version })} · {relativeTime(artifact.updated_at, locale)}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
                <DropdownMenuLabel>{t('versions')}</DropdownMenuLabel>
                {(versions.data ?? []).map((v) => (
                  <DropdownMenuItem
                    key={v.version}
                    onSelect={() => setVersion(v.version === artifact.current_version ? undefined : v.version)}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">
                        {t('versionShort', { version: v.version })}
                        {v.label ? ` · ${v.label}` : ''}
                      </span>
                      <span className="text-muted-foreground text-xs">{relativeTime(v.created_at, locale)}</span>
                    </span>
                    {v.version === artifact.current_version ? <span className="text-muted-foreground text-xs">{t('current')}</span> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {canEdit && !isDoc ? (
              <Button size="sm" variant={coding ? 'secondary' : 'ghost'} onClick={() => setCoding((on) => !on)}>
                <CodeIcon /> {t('editCode')}
              </Button>
            ) : null}
            {canEdit ? (
              <Button size="sm" variant="ghost" onClick={() => setAsking(true)} className="hidden sm:inline-flex">
                <SparkleIcon /> {t('askAgent')}
              </Button>
            ) : null}
            {artifact.can_edit ? (
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
                <DropdownMenuItem onSelect={() => window.open(artifact.version.view_url, '_blank', 'noopener')}>
                  <ArrowSquareOutIcon /> {t('openNewTab')}
                </DropdownMenuItem>
                {!isDoc ? (
                  <DropdownMenuItem onSelect={() => frame.current?.requestFullscreen?.()}>
                    <CornersOutIcon /> {t('fullScreen')}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={() => window.open(`${artifact.version.view_url}?print=1`, '_blank', 'noopener')}>
                  <FilePdfIcon /> {t('downloadPdf')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={download}>
                  <DownloadSimpleIcon /> {t('download')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => mutations.pin.mutate({ artifactId: artifact.artifact_id, pinned: !artifact.pinned })}>
                  {artifact.pinned ? <PushPinSlashIcon /> : <PushPinIcon />} {artifact.pinned ? t('unpin') : t('pin')}
                </DropdownMenuItem>
                {artifact.can_edit ? (
                  <>
                    <DropdownMenuItem onSelect={() => setRenaming(true)}>
                      <PencilSimpleIcon /> {t('rename')}
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
        ) : null}
      </header>

      {artifact && viewingOld ? (
        <div className="bg-muted flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs">
          <span>{t('viewingOld', { version: artifact.version.version, current: artifact.current_version })}</span>
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
                  const restored = await mutations.restore.mutateAsync({ artifactId: artifact.artifact_id, version: artifact.version.version });
                  setVersion(undefined);
                  successToast(t('restored', { version: artifact.version.version, current: restored.current_version }));
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
              key={`${artifact.artifact_id}:${viewingOld ? artifact.version.version : 'current'}`}
              projectId={projectId}
              artifact={artifact}
              editable={canEdit}
              onStatus={setDocStatus}
            />
          </div>
        ) : (
          <>
            {coding && canEdit ? (
              <CodePane key={`${artifact.artifact_id}:${artifact.version.version}`} projectId={projectId} artifact={artifact} />
            ) : null}
            <div className="bg-muted relative min-w-0 flex-1">
              {viewUrl ? (
                <ArtifactFrame ref={frame} key={viewUrl} src={viewUrl} title={artifact.title} className="absolute inset-0 size-full border-0" />
              ) : null}
            </div>
          </>
        )}
      </div>

      {artifact && sharing ? <ShareArtifactDialog projectId={projectId} artifact={artifact} open onOpenChange={setSharing} /> : null}
      {artifact ? <AskAgentDialog projectId={projectId} artifact={artifact} open={asking} onOpenChange={setAsking} /> : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('deleteTitle')}
        description={t('deleteHint')}
        confirmLabel={t('delete')}
        confirmVariant="destructive"
        isPending={mutations.remove.isPending}
        onConfirm={async () => {
          await mutations.remove.mutateAsync(artifactId);
          successToast(t('deleted'));
          router.push(`/projects/${projectId}/artifacts`);
        }}
      />
    </div>
  );
}

/** An HTML page's code next to the live page. Save (or ⌘S) publishes a new version; the page reloads with it. */
function CodePane({ projectId, artifact }: { projectId: string; artifact: ArtifactDetail }) {
  const t = useTranslations('artifacts');
  const { publish } = useArtifactMutations(projectId);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    readArtifactFile(projectId, artifact.artifact_id, { version: artifact.version.version })
      .then((blob) => blob.text())
      .then((text) => live && setSource(text))
      .catch((err: Error) => errorToast(err.message));
    return () => {
      live = false;
    };
  }, [projectId, artifact.artifact_id, artifact.version.version]);

  const save = async (content: string) => {
    const next = await publish.mutateAsync({
      artifactId: artifact.artifact_id,
      base_version: artifact.current_version,
      files: { 'index.html': { content } },
    });
    successToast(t('saved', { version: next.current_version }));
  };

  return (
    <div className="flex w-1/2 max-w-3xl min-w-80 flex-col border-r">
      {source === null ? (
        <Skeleton className="m-3 flex-1 rounded-md" />
      ) : (
        <CodeEditor content={source} originalContent={source} fileName="index.html" language="html" onSave={save} className="h-full" />
      )}
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
