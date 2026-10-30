'use client';

import { type ArtifactVersion } from '@kortix/sdk';
import { useArtifact, useArtifactMutations, useArtifactVersions } from '@kortix/sdk/react';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from '@kortix/ui/breadcrumb';
import { Button } from '@kortix/ui/button';
import { ButtonGroup } from '@kortix/ui/button-group';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { ErrorState } from '@kortix/ui/error-state';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { SessionParticipantStack, participantLabel } from '@kortix/ui/session/participants/session-participants';
import { SplitSheet, SplitSheetMain } from '@kortix/ui/split-sheet';
import { successToast } from '@kortix/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@kortix/ui/tooltip';
import { SidebarToggle } from '@kortix/ui/workspace';
import { useOptionalSidebar } from '@kortix/ui/sidebar';
import { reloadFrame } from '@kortix/ui/apps';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretRightIcon,
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  XIcon,
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
import { useEffect, useRef, useState } from 'react';

import { drivePathToParam } from '@/features/drives/drive-path-param';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { VISIBILITY_ICON, relativeTime } from './artifact-meta';
import { AskAgentSheet } from './ask-agent-sheet';
import { ArtifactFrame, artifactFrameKey, printArtifact } from '@kortix/ui/artifacts';
import { DocEditor, type DocSaveStatus } from './doc-editor';
import { ShareArtifactDialog } from './share-artifact-dialog';

/** Saves closer than this show as one row of the history: an editing burst. */
const BURST_MS = 5 * 60_000;

type HistoryRow = ArtifactVersion & { saves: number };

/** History rows by calendar day, newest first: "Today", "Yesterday", then the date. */
function historyDays(rows: HistoryRow[], locale: string): Array<{ day: string; rows: HistoryRow[] }> {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = midnight(new Date());
  const days: Array<{ day: string; rows: HistoryRow[] }> = [];
  for (const row of rows) {
    const at = new Date(row.created_at);
    const ago = Math.round((today - midnight(at)) / 86_400_000);
    const label = ago <= 1 ? relative.format(-ago, 'day') : date.format(at);
    const day = label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
    if (days.at(-1)?.day === day) days.at(-1)!.rows.push(row);
    else days.push({ day, rows: [row] });
  }
  return days;
}

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

/**
 * /projects/[id]/artifacts/[artifactId] — one artifact, full height. A doc is
 * its Markdown file in the doc editor (read-only without write access in
 * Files); an HTML page runs in a sandboxed frame. The history is the Files
 * commit log of its path.
 */
export function ArtifactViewer({
  projectId,
  artifactId,
  onClose,
}: {
  projectId: string;
  artifactId: string;
  /** Embedded (the session panel): fill the panel, close instead of the sidebar toggle, and a way to the full page. */
  onClose?: () => void;
}) {
  const embedded = !!onClose;
  const t = useTranslations('artifacts');
  const locale = useLocale();
  const router = useRouter();
  const [version, setVersion] = useState<string | undefined>(undefined);
  const query = useArtifact(projectId, artifactId, version);
  const artifact = query.data;
  const mutations = useArtifactMutations(projectId);
  const frame = useRef<HTMLDivElement>(null);
  const [docStatus, setDocStatus] = useState<DocSaveStatus>('saved');
  // Bumped by a conflict's Reload: the editor opens again on the version now in Files.
  const [reloads, setReloads] = useState(0);
  const reloadDoc = () => {
    setDocStatus('saved');
    void query.refetch().then(() => setReloads((n) => n + 1));
  };
  // Export as PDF prints the saved file: with edits pending, it waits for the autosave.
  const [exporting, setExporting] = useState(false);
  const exportUrl = artifact?.version.view_url;
  useEffect(() => {
    if (!exporting || !exportUrl || docStatus !== 'saved') return;
    setExporting(false);
    printArtifact(exportUrl);
  }, [exporting, exportUrl, docStatus]);
  const [sharing, setSharing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const versions = useArtifactVersions(projectId, artifactId, historyOpen);
  const viewUrl = artifact?.version.view_url;
  const viewingOld = !!artifact?.version.id;
  const frameKey = artifact ? artifactFrameKey(artifact, artifact.version.id) : null;
  const canEdit = !!artifact?.can_edit && !viewingOld;
  const isDoc = artifact?.type === 'doc';
  const sidebar = useOptionalSidebar();

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

  const VisIcon = artifact ? VISIBILITY_ICON[artifact.visibility] : null;
  const statusText = isDoc && canEdit && docStatus !== 'saved' ? t(`docStatus.${docStatus}`) : null;
  const folder = artifact ? (artifact.path.endsWith(`/${artifact.entry}`) ? artifact.path.slice(0, -artifact.entry.length - 1) : artifact.path) : '';
  const rows = historyRows(versions.data ?? []);
  const people = artifact?.participants;

  return (
    <div className={embedded ? 'flex h-full min-h-0 flex-col overflow-hidden' : 'flex h-svh flex-col overflow-hidden'}>
      {/* The project page header (ProjectPageHeader's title-bar classes): a breadcrumb, then quiet actions.
          Embedded in the session panel: the panel's own plain header row. */}
      <header
        className={
          embedded
            ? 'flex h-10 shrink-0 items-center gap-1 border-b px-1'
            : 'kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2'
        }
        data-sidebar-collapsed={embedded ? undefined : sidebar?.state === 'collapsed' || undefined}
      >
        {embedded ? null : <SidebarToggle />}
        <Breadcrumb className={`${embedded ? '' : 'kx-titlebar-tabs '}flex h-10 min-w-0 flex-1 items-center px-3`}>
          <BreadcrumbList className="min-w-0 flex-nowrap gap-1.5 sm:gap-1.5">
            {embedded ? null : (
              <>
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbLink asChild>
                    <Link href={`/projects/${projectId}/artifacts`}>{t('title')}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator>
                  <CaretRightIcon />
                </BreadcrumbSeparator>
              </>
            )}
            <BreadcrumbItem className="min-w-0 flex-1 gap-2">
              {artifact ? (
                renaming ? (
                  <input
                    autoFocus
                    defaultValue={artifact.title}
                    aria-label={t('rename')}
                    className="text-foreground min-w-0 flex-1 bg-transparent font-medium outline-none"
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
                  <h1 className="min-w-0 truncate">
                    <button
                      type="button"
                      className="text-foreground max-w-full truncate font-medium disabled:cursor-default"
                      disabled={!artifact.can_manage}
                      title={artifact.can_manage ? t('rename') : undefined}
                      onClick={() => setRenaming(true)}
                    >
                      {artifact.title}
                    </button>
                  </h1>
                )
              ) : null}
              {artifact && VisIcon ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground flex shrink-0" aria-label={t(`visibility.${artifact.visibility}`)}>
                      <VisIcon weight="fill" className="size-3.5" aria-hidden />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t(`visibility.${artifact.visibility}`)}</TooltipContent>
                </Tooltip>
              ) : null}
              {artifact?.pinned ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground flex shrink-0" aria-label={t('pinned')}>
                      <PushPinIcon weight="fill" className="size-3.5" aria-hidden />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('pinned')}</TooltipContent>
                </Tooltip>
              ) : null}
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        {artifact ? (
          <div className="flex shrink-0 items-center gap-2">
            {docStatus === 'conflict' && statusText ? (
              <Button size="sm" variant="ghost" className="text-xs" onClick={reloadDoc}>
                {statusText} · {t('conflictReload')}
              </Button>
            ) : statusText ? (
              <span className="text-muted-foreground px-2 text-xs">{statusText}</span>
            ) : null}
            {/* Who can open it, for every viewer, as the session header shows its people. */}
            {people ? (
              <SessionParticipantStack
                participants={people}
                label={t('peopleWithAccess', { names: people.participants.map(participantLabel).filter(Boolean).join(', ') })}
              />
            ) : null}
            {/* Two groups: the artifact's history and Ask AI; then Share and More. */}
            <ButtonGroup>
              <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="secondary" aria-label={t('history')}>
                        <ClockCounterClockwiseIcon className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t('editedAgo', { time: relativeTime(artifact.updated_at, locale) })}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
                  {versions.isLoading ? (
                    <div className="flex flex-col gap-1 p-1">
                      <Skeleton className="h-7 w-full" />
                      <Skeleton className="h-7 w-full" />
                    </div>
                  ) : rows.length === 0 ? (
                    <p className="text-muted-foreground px-2 py-3 text-xs">{t('historyEmpty')}</p>
                  ) : (
                    historyDays(rows, locale).map(({ day, rows: dayRows }, d) => (
                      <DropdownMenuGroup key={day}>
                        {d > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel>{day}</DropdownMenuLabel>
                        {dayRows.map((v) => {
                          const current = v.id === rows[0]?.id;
                          const viewing = current ? !version : version === v.id;
                          return (
                            <DropdownMenuItem key={v.id} onSelect={() => setVersion(current ? undefined : v.id)} aria-current={viewing || undefined}>
                              <span className="tabular-nums">{new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(v.created_at))}</span>
                              {v.saves > 1 ? <span className="text-muted-foreground text-xs tabular-nums">{t('saves', { count: v.saves })}</span> : null}
                              {current || viewing ? (
                                <span className={`ml-auto text-xs ${viewing && !current ? 'text-foreground' : 'text-muted-foreground'}`}>
                                  {current ? t('current') : t('viewing')}
                                </span>
                              ) : null}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuGroup>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              {canEdit ? (
                <Button
                size="xs"
                variant="secondary"
                onClick={() => setAsking((open) => !open)}
                aria-expanded={asking}
                className="hidden aria-expanded:bg-accent sm:inline-flex"
              >
                  <SparkleIcon weight="fill" className="size-3.5" aria-hidden /> {t('askAgent')}
                </Button>
              ) : null}
            </ButtonGroup>
            <ButtonGroup>
              {artifact.can_manage ? (
                <Button size="xs" variant="secondary" onClick={() => setSharing(true)}>
                  <ShareNetworkIcon className="size-3.5" aria-hidden /> {t('share')}
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="secondary" aria-label={t('actions')}>
                    <DotsThreeIcon className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {isDoc ? (
                    <DropdownMenuItem onSelect={() => setExporting(true)}>
                      <FilePdfIcon /> {t('exportPdf')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => frame.current?.requestFullscreen?.()}>
                      <CornersOutIcon /> {t('fullScreen')}
                    </DropdownMenuItem>
                  )}
                  {!isDoc && viewUrl && frameKey ? (
                    <DropdownMenuItem onSelect={() => reloadFrame(frameKey, viewUrl)}>
                      <ArrowClockwiseIcon /> {t('refresh')}
                    </DropdownMenuItem>
                  ) : null}
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
            </ButtonGroup>
          </div>
        ) : null}
        {embedded ? (
          <div className="flex shrink-0 items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('openFullPage')} asChild>
                  <Link href={`/projects/${projectId}/artifacts/${artifactId}`}>
                    <ArrowsOutSimpleIcon className="size-3.5" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('openFullPage')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('close')} onClick={onClose}>
                  <XIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('close')}</TooltipContent>
            </Tooltip>
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

      {/* Ask agent: a column beside the artifact with one session's chat (covers it when narrow). */}
      <SplitSheet open={asking && !!artifact} onOpenChange={setAsking} size="lg" className="h-auto min-h-0 flex-1">
        <SplitSheetMain className="flex">
          {!artifact ? (
            <div className="grid flex-1 place-items-center">
              <Loading className="size-4" />
            </div>
          ) : isDoc ? (
            <div className="bg-background min-w-0 flex-1 overflow-y-auto">
              <DocEditor
                // Read-only: a new file version opens a new editor (an editable one takes it in place).
              key={`${artifact.artifact_id}:${artifact.version.id ?? 'now'}:${reloads}${canEdit ? '' : `:${artifact.entry_version}`}`}
                projectId={projectId}
                artifact={artifact}
                editable={canEdit}
                onStatus={setDocStatus}
                onReload={reloadDoc}
              />
            </div>
          ) : (
            <div className="bg-muted relative min-w-0 flex-1">
              {viewUrl ? (
                <ArtifactFrame ref={frame} frameKey={frameKey!} src={viewUrl} title={artifact.title} className="absolute inset-0 size-full border-0" />
              ) : null}
            </div>
          )}
        </SplitSheetMain>
        {artifact ? <AskAgentSheet projectId={projectId} artifact={artifact} onAgentWork={() => void query.refetch()} /> : null}
      </SplitSheet>

      {artifact && sharing ? <ShareArtifactDialog projectId={projectId} artifact={artifact} open onOpenChange={setSharing} /> : null}
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
          if (onClose) onClose();
          else router.push(`/projects/${projectId}/artifacts`);
        }}
      />
    </div>
  );
}
