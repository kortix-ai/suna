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
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@kortix/ui/tooltip';
import { SidebarToggle } from '@kortix/ui/workspace';
import {
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  CodeIcon,
  CornersOutIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  ListBulletsIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
  PlayIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShareNetworkIcon,
  SparkleIcon,
  TextBIcon,
  TextHTwoIcon,
  TextHThreeIcon,
  TextItalicIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';

import { ARTIFACT_TYPE_ICON, ArtifactFrame, VISIBILITY_ICON, relativeTime, useStableViewUrl } from './artifact-meta';
import { ShareArtifactDialog } from './share-artifact-dialog';

type Mode = 'view' | 'doc-edit' | 'source';

/** Messages from the artifact page (the kit's bridge), only from this frame. */
function useFrameMessage(frame: React.RefObject<HTMLIFrameElement | null>, handler: (m: Record<string, unknown>) => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as Record<string, unknown> | null;
      if (m && m.kortix === 'artifact') latest.current(m);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame]);
}

function post(frame: HTMLIFrameElement | null, message: Record<string, unknown>) {
  frame?.contentWindow?.postMessage({ kortix: 'artifact', ...message }, '*');
}

/** The edited page from the doc kit: its DOM without the injected kit nodes. */
function requestHtml(frame: HTMLIFrameElement | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!frame?.contentWindow) return reject(new Error('The page is not loaded'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('The page did not answer'));
    }, 5_000);
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { kortix?: string; op?: string; id?: string; html?: string } | null;
      if (e.source !== frame.contentWindow || m?.kortix !== 'artifact' || m.op !== 'html' || m.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(String(m.html ?? ''));
    };
    window.addEventListener('message', onMessage);
    post(frame, { op: 'get', id });
  });
}

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
 * /projects/[id]/artifacts/[artifactId] — one artifact, full height. The
 * owner (or a project manager) edits a doc in place or any page's source,
 * asks an agent for a change, shares it, and moves between versions.
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
  const [mode, setMode] = useState<Mode>('view');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // Bumped to reload the page: a cancelled edit drops its changes.
  const [reloads, setReloads] = useState(0);
  const versions = useArtifactVersions(projectId, artifactId, versionsOpen);
  const viewUrl = useStableViewUrl(artifact ? `${artifact.artifact_id}:${artifact.version.version}` : null, artifact?.version.view_url);
  const viewingOld = artifact ? artifact.version.version !== artifact.current_version : false;
  const canEdit = !!artifact?.can_edit && !viewingOld;

  // ?edit=1 (a new blank doc) and ?source=1 (a new blank page) open the editor once.
  const [urlHandled, setUrlHandled] = useState(false);
  if (artifact && !urlHandled) {
    setUrlHandled(true);
    if (artifact.can_edit && search.get('edit') === '1' && artifact.type === 'doc') setMode('doc-edit');
    else if (artifact.can_edit && search.get('source') === '1') setMode('source');
  }

  useFrameMessage(frame, (m) => {
    if (m.op === 'ready' && mode === 'doc-edit') post(frame.current, { op: 'edit', on: true });
    if (m.op === 'dirty') setDirty(true);
  });

  useEffect(() => {
    post(frame.current, { op: 'edit', on: mode === 'doc-edit' });
  }, [mode]);

  const changeMode = (next: Mode) => {
    setDirty(false);
    setMode(next);
  };

  const publish = useCallback(async (html: string) => {
    if (!artifact) return;
    setSaving(true);
    try {
      const next = await mutations.publish.mutateAsync({
        artifactId: artifact.artifact_id,
        base_version: artifact.current_version,
        files: { 'index.html': { content: html } },
      });
      successToast(t('saved', { version: next.current_version }));
      setDirty(false);
      setMode('view');
    } finally {
      setSaving(false);
    }
  }, [artifact, mutations.publish, t]);

  const saveDoc = async () => {
    try {
      await publish(await requestHtml(frame.current));
    } catch (err) {
      errorToast((err as Error).message);
    }
  };

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
            <DropdownMenu open={versionsOpen} onOpenChange={setVersionsOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="text-muted-foreground hidden font-normal md:inline-flex">
                  {t('versionShort', { version: artifact.version.version })} · {relativeTime(artifact.version.created_at, locale)}
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

            {canEdit && mode === 'view' ? (
              <Button size="sm" variant="ghost" onClick={() => changeMode(artifact.type === 'doc' ? 'doc-edit' : 'source')}>
                <PencilSimpleIcon /> {t('edit')}
              </Button>
            ) : null}
            {artifact.type === 'slides' && mode === 'view' ? (
              <Button size="sm" variant="ghost" onClick={() => frame.current?.requestFullscreen?.()}>
                <PlayIcon /> {t('present')}
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
                <DropdownMenuItem onSelect={() => frame.current?.requestFullscreen?.()}>
                  <CornersOutIcon /> {t('fullScreen')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={download}>
                  <DownloadSimpleIcon /> {t('download')}
                </DropdownMenuItem>
                {canEdit && artifact.type === 'doc' ? (
                  <DropdownMenuItem onSelect={() => changeMode('source')}>
                    <CodeIcon /> {t('editSource')}
                  </DropdownMenuItem>
                ) : null}
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

      {mode === 'doc-edit' ? (
        <div className="bg-background flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
          {[
            { cmd: 'bold', icon: TextBIcon, label: t('bold') },
            { cmd: 'italic', icon: TextItalicIcon, label: t('italic') },
            { cmd: 'formatBlock', arg: 'h2', icon: TextHTwoIcon, label: t('heading') },
            { cmd: 'formatBlock', arg: 'h3', icon: TextHThreeIcon, label: t('subheading') },
            { cmd: 'insertUnorderedList', icon: ListBulletsIcon, label: t('bulletList') },
          ].map(({ cmd, arg, icon: Icon, label }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => post(frame.current, { op: 'exec', cmd, arg })}>
                  <Icon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('link')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const url = window.prompt(t('linkPrompt'));
                  if (url) post(frame.current, { op: 'exec', cmd: 'createLink', arg: url });
                }}
              >
                <LinkSimpleIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('link')}</TooltipContent>
          </Tooltip>
          <span className="text-muted-foreground ml-2 hidden text-xs sm:inline">{t('editingHint')}</span>
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => { changeMode('view'); setReloads((n) => n + 1); }} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={saveDoc} disabled={saving || !dirty}>
              {saving ? t('saving') : t('save')}
            </Button>
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {mode === 'source' && artifact ? (
          <SourceEditor
            key={`${artifact.artifact_id}:${artifact.version.version}`}
            projectId={projectId}
            artifact={artifact}
            saving={saving}
            onCancel={() => changeMode('view')}
            onSave={publish}
          />
        ) : null}
        <div className="bg-muted relative min-w-0 flex-1">
          {viewUrl && artifact ? (
            <ArtifactFrame ref={frame} key={`${viewUrl}#${reloads}`} src={viewUrl} title={artifact.title} className="absolute inset-0 size-full border-0" />
          ) : (
            <Skeleton className="absolute inset-4 rounded-md" />
          )}
        </div>
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

/** The page source next to the live page. Save publishes it as a new version (⌘S). */
function SourceEditor({
  projectId,
  artifact,
  saving,
  onCancel,
  onSave,
}: {
  projectId: string;
  artifact: ArtifactDetail;
  saving: boolean;
  onCancel: () => void;
  onSave: (html: string) => Promise<void>;
}) {
  const t = useTranslations('artifacts');
  const [source, setSource] = useState<string | null>(null);
  const [original, setOriginal] = useState('');
  useEffect(() => {
    let live = true;
    readArtifactFile(projectId, artifact.artifact_id, { version: artifact.version.version })
      .then((blob) => blob.text())
      .then((text) => {
        if (!live) return;
        setSource(text);
        setOriginal(text);
      })
      .catch((err: Error) => errorToast(err.message));
    return () => {
      live = false;
    };
  }, [projectId, artifact.artifact_id, artifact.version.version]);
  const dirty = source !== null && source !== original;

  return (
    <div className="flex w-full max-w-[50%] min-w-80 flex-col border-r">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <CodeIcon className="text-muted-foreground size-4" />
        <span className="font-mono text-xs">index.html</span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            {t('close')}
          </Button>
          <Button size="sm" onClick={() => source !== null && onSave(source)} disabled={!dirty || saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        </span>
      </div>
      {source === null ? (
        <Skeleton className="m-3 flex-1 rounded-md" />
      ) : (
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (dirty && !saving) void onSave(source);
            }
          }}
          spellCheck={false}
          aria-label={t('editSource')}
          className="bg-background text-foreground min-h-0 flex-1 resize-none p-3 font-mono text-xs leading-relaxed outline-none"
        />
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
