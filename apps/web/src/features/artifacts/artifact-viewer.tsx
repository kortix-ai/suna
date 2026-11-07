'use client';

import type { ArtifactVersion } from '@kortix/sdk';
import { useArtifact, useArtifactMutations, useArtifactVersions } from '@kortix/sdk/react';
import { cn } from '@kortix/ui';
import { reloadFrame } from '@kortix/ui/apps';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@kortix/ui/breadcrumb';
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
import Hint from '@kortix/ui/hint';
import Loading from '@kortix/ui/loading';
import {
  SessionParticipantStack,
  participantLabel,
} from '@kortix/ui/session/participants/session-participants';
import { useOptionalSidebar } from '@kortix/ui/sidebar';
import { Skeleton } from '@kortix/ui/skeleton';
import { SplitSheet, SplitSheetMain } from '@kortix/ui/split-sheet';
import { dismissToast, errorToast, progressToast, successToast } from '@kortix/ui/toast';
import { SidebarToggle } from '@kortix/ui/workspace';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  CaretRightIcon,
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
  XIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { drivePathToParam } from '@kortix/ui/files';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { ArtifactFrame, artifactFrameKey, printArtifact } from '@kortix/ui/artifacts';
import { VISIBILITY_ICON, relativeTime } from './artifact-meta';
import { AskAgentSheet } from './ask-agent-sheet';
import { DocEditor, type DocSaveStatus } from './doc-editor';
import { ShareArtifactDialog } from './share-artifact-dialog';
import { rootRem, useElementWidth } from './use-element-width';

/** A small status mark beside the title (visibility, pinned): focusable for its hint. */
const HEADER_MARK =
  'text-muted-foreground focus-visible:ring-ring flex shrink-0 rounded-sm outline-none focus-visible:ring-2';

/** Saves closer than this show as one row of the history: an editing burst. */
const BURST_MS = 5 * 60_000;

type HistoryRow = ArtifactVersion & { saves: number };

/** History rows by calendar day, newest first: "Today", "Yesterday", then the date. */
function historyDays(
  rows: HistoryRow[],
  locale: string,
): Array<{ day: string; rows: HistoryRow[] }> {
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
    if (row && newer && Date.parse(newer.created_at) - Date.parse(v.created_at) <= BURST_MS)
      row.saves += 1;
    else rows.push({ ...v, saves: 1 });
  });
  return rows;
}

/**
 * /workspaces/[id]/artifacts/[artifactId] — one artifact, full height. A doc is
 * its Markdown file in the doc editor (read-only without write access in
 * Files); an HTML page runs in a sandboxed frame. The history is the Files
 * commit log of its path.
 */
type ArtifactViewerProps = {
  projectId: string;
  artifactId: string;
  /** Embedded (the session panel): fill the panel, close instead of the sidebar toggle, and a way to the full page. */
  onClose?: () => void;
};

export function ArtifactViewer(props: ArtifactViewerProps) {
  return <ArtifactViewerContent key={`${props.projectId}:${props.artifactId}`} {...props} />;
}

function ArtifactViewerContent({ projectId, artifactId, onClose }: ArtifactViewerProps) {
  const embedded = !!onClose;
  const t = useTranslations('artifacts');
  const locale = useLocale();
  const router = useRouter();
  const [version, setVersion] = useState<string | undefined>(undefined);
  const query = useArtifact(projectId, artifactId, version);
  const artifact = query.data;
  useLayoutEffect(() => {
    if (embedded || !artifact?.title) return;
    const title = artifact.title;
    const syncTitle = () => {
      if (document.title !== title) document.title = title;
    };
    syncTitle();
    // Streamed route metadata can arrive after the artifact query resolves.
    const observer = new MutationObserver(syncTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [embedded, artifact?.title]);
  const mutations = useArtifactMutations(projectId);
  const frame = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const headerWidth = useElementWidth(header);
  const rem = headerWidth === null ? 16 : rootRem();
  // Below `sm` (40rem) the header has room for its essentials only: Ask AI moves into ⋯ and Share is an icon.
  const compact = headerWidth !== null && headerWidth < 40 * rem;
  const [docStatus, setDocStatus] = useState<DocSaveStatus>('saved');
  // Bumped by a conflict's Reload: the editor opens again on the version now in Files.
  const [reloads, setReloads] = useState(0);
  const reloadDoc = () => {
    setDocStatus('saved');
    void query.refetch().then(() => setReloads((n) => n + 1));
  };
  // Export as PDF prints the saved file: with edits pending, it waits for the autosave and says
  // so. A save that fails or meets a conflict ends the export with a message, never a late print.
  const [exporting, setExporting] = useState(false);
  const exportUrl = artifact?.version.view_url;
  const exportToast = `artifact-export-${artifactId}`;
  const exportPdf = () => {
    if (!exportUrl) return;
    if (docStatus === 'saved') return printArtifact(exportUrl);
    if (docStatus === 'error' || docStatus === 'conflict') return errorToast(t('exportBlocked'));
    setExporting(true);
    progressToast(t('exportWaiting'), { id: exportToast });
  };
  useEffect(() => {
    if (!exporting) return;
    if (docStatus === 'error' || docStatus === 'conflict') {
      setExporting(false);
      dismissToast(exportToast);
      errorToast(t('exportBlocked'));
      return;
    }
    if (!exportUrl || docStatus !== 'saved') return;
    setExporting(false);
    dismissToast(exportToast);
    printArtifact(exportUrl);
  }, [exporting, exportUrl, docStatus, exportToast, t]);
  const [sharing, setSharing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const titleButton = useRef<HTMLButtonElement>(null);
  // Set by the ⋯ menu's Rename: Radix returns focus to ⋯ when the menu closes, which would leave
  // the new field without the keyboard. The menu's `onCloseAutoFocus` reads it and keeps focus.
  const renameFromMenu = useRef(false);
  // One rename ends once: Enter or Escape unmounts the field, and its blur must not save again.
  const renameOver = useRef(false);
  const renameInput = useRef<HTMLInputElement>(null);
  // The field takes focus with the name selected: typing replaces it, an arrow key edits it. From a
  // click on the title, once it is in the page. From ⋯ → Rename, only when the menu has let go of
  // focus (its `onCloseAutoFocus`): measured, the menu's focus trap pulled an earlier focus back to
  // its item, which then unmounted and left focus on the page body.
  const focusRename = () => {
    renameInput.current?.focus();
    renameInput.current?.select();
  };
  useEffect(() => {
    if (renaming && !renameFromMenu.current) focusRename();
  }, [renaming]);
  const startRename = () => {
    renameOver.current = false;
    setRenaming(true);
  };
  /** `title` null cancels. `returnFocus`: the keyboard ended it, so it goes back to the title. */
  const finishRename = (title: string | null, returnFocus = false) => {
    if (renameOver.current) return;
    renameOver.current = true;
    setRenaming(false);
    // The title button mounts again with this render: read the ref when the frame comes.
    if (returnFocus) requestAnimationFrame(() => titleButton.current?.focus({ preventScroll: true }));
    const next = title?.trim();
    const current = query.data;
    if (!current || !next || next === current.title) return;
    // A failed rename toasts from the API client; the title shows the saved name again.
    mutations.update.mutate({ artifactId: current.artifact_id, title: next });
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  // Read with the History menu, and while an old version is open: its banner names its time.
  const versions = useArtifactVersions(projectId, artifactId, historyOpen || !!version);
  const viewingOld = !!artifact?.version.id;
  const canEdit = !!artifact?.can_edit && !viewingOld;
  const isDoc = artifact?.type === 'doc';
  // A read-only doc opens a new editor per file version: an editable one takes new text in place.
  const docKey = artifact
    ? `${artifact.artifact_id}:${artifact.version.id ?? 'now'}:${reloads}${canEdit || viewingOld ? '' : `:${artifact.entry_version}`}`
    : '';
  // A new editor (a read-only doc's new version, a Reload) opens where the person was reading.
  // The scroll position is kept only while an editor shows its text: the empty editor's collapse
  // to the top is not a place the person chose.
  const docScroller = useRef<HTMLDivElement>(null);
  const docScroll = useRef({ top: 0, ready: false });
  useLayoutEffect(() => {
    docScroll.current.ready = false;
  }, [docKey]);
  const restoreDocScroll = useCallback(() => {
    const scroller = docScroller.current;
    if (scroller && docScroll.current.top > 0) scroller.scrollTop = docScroll.current.top;
    docScroll.current.ready = true;
  }, []);
  const sidebar = useOptionalSidebar();
  const viewUrl = artifact?.version.view_url;
  const frameKey = artifact ? artifactFrameKey(artifact, artifact.version.id) : null;
  const openVersion = (next: string | undefined) => setVersion(next);

  // A failed read with nothing to show. Only 403 and 404 mean the artifact is gone for this
  // viewer; anything else (a 5xx, the network) is worth another try.
  if (query.isError && !artifact) {
    const status = (query.error as { status?: number } | null)?.status;
    const gone = status === 403 || status === 404;
    return (
      <div className={embedded ? 'flex h-full min-h-0 flex-col' : 'mx-auto w-full max-w-3xl p-8'}>
        {/* Embedded in the session panel: its own Close, as the loaded header has. */}
        {embedded ? (
          <div className="flex h-10 shrink-0 items-center justify-end border-b px-1">
            <Hint label={t('close')} side="bottom">
              <Button size="icon-sm" variant="ghost" aria-label={t('close')} onClick={onClose}>
                <XIcon className="size-3.5" />
              </Button>
            </Hint>
          </div>
        ) : null}
        <div className={embedded ? 'p-6' : undefined}>
          <ErrorState
            title={t(gone ? 'notFoundTitle' : 'openError')}
            description={gone ? t('notFoundHint') : undefined}
            action={
              !gone ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  {query.isFetching ? <Loading className="size-4 shrink-0" /> : null}
                  {t('retry')}
                </Button>
              ) : embedded ? undefined : (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/workspaces/${projectId}/artifacts`}>{t('back')}</Link>
                </Button>
              )
            }
          />
        </div>
      </div>
    );
  }

  const VisIcon = artifact ? VISIBILITY_ICON[artifact.visibility] : null;
  const statusText = isDoc && canEdit && docStatus !== 'saved' ? t(`docStatus.${docStatus}`) : null;
  // A doc this viewer may read but not change looks editable unless the header says so.
  const viewOnly = isDoc && !!artifact && !artifact.can_edit && !viewingOld;
  const folder = artifact
    ? artifact.path.endsWith(`/${artifact.entry}`)
      ? artifact.path.slice(0, -artifact.entry.length - 1)
      : artifact.path
    : '';
  const rows = historyRows(versions.data ?? []);
  const openedVersionAt = version
    ? versions.data?.find((entry) => entry.id === version)?.created_at
    : undefined;
  const people = artifact?.participants;

  return (
    <div
      className={
        embedded
          ? 'flex h-full min-h-0 flex-col overflow-hidden'
          : 'flex h-svh flex-col overflow-hidden'
      }
    >
      {/* The project page header (ProjectPageHeader's title-bar classes): a breadcrumb, then quiet actions.
          Embedded in the session panel: the panel's own plain header row. */}
      <header
        ref={header}
        className={
          embedded
            ? 'flex h-10 shrink-0 items-center gap-1 border-b px-1'
            : 'kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-1 border-b px-2'
        }
        data-sidebar-collapsed={embedded ? undefined : sidebar?.state === 'collapsed' || undefined}
      >
        {embedded ? null : <SidebarToggle />}
        <Breadcrumb
          className={cn(
            !embedded && 'kx-titlebar-tabs',
            'flex h-10 min-w-0 flex-1 items-center px-3',
          )}
        >
          <BreadcrumbList className="min-w-0 flex-nowrap gap-1.5 sm:gap-1.5">
            {embedded ? null : (
              <>
                <BreadcrumbItem className="shrink-0">
                  <BreadcrumbLink asChild>
                    <Link href={`/workspaces/${projectId}/artifacts`}>{t('title')}</Link>
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
                    ref={renameInput}
                    defaultValue={artifact.title}
                    aria-label={t('rename')}
                    className="text-foreground min-w-0 flex-1 bg-transparent font-medium outline-none"
                    // Clicking away keeps the new name, as the session title does. Escape cancels.
                    onBlur={(e) => finishRename(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        finishRename(null, true);
                      }
                      if (e.key === 'Enter') finishRename(e.currentTarget.value, true);
                    }}
                  />
                ) : (
                  <h1 className="text-foreground min-w-0 truncate font-medium">
                    {artifact.can_manage ? (
                      <Hint label={t('rename')} side="bottom">
                        <button
                          ref={titleButton}
                          type="button"
                          className="max-w-full truncate"
                          onClick={startRename}
                        >
                          {artifact.title}
                        </button>
                      </Hint>
                    ) : (
                      artifact.title
                    )}
                  </h1>
                )
              ) : null}
              {artifact && VisIcon ? (
                <Hint label={t(`visibility.${artifact.visibility}`)} side="bottom">
                  {/* Focusable, so the keyboard reaches the hint too. */}
                  <span
                    role="img"
                    tabIndex={0}
                    className={HEADER_MARK}
                    aria-label={t(`visibility.${artifact.visibility}`)}
                  >
                    <VisIcon weight="fill" className="size-3.5" aria-hidden />
                  </span>
                </Hint>
              ) : null}
              {artifact?.pinned ? (
                <Hint label={t('pinned')} side="bottom">
                  <span role="img" tabIndex={0} className={HEADER_MARK} aria-label={t('pinned')}>
                    <PushPinIcon weight="fill" className="size-3.5" aria-hidden />
                  </span>
                </Hint>
              ) : null}
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        {/* The doc's save state, or that it is view only. It gives way before the actions: it
            truncates, and the actions never leave the header. A conflict's choice is above the doc. */}
        {statusText ? (
          <span
            className={cn(
              'max-w-40 min-w-0 shrink truncate px-2 text-xs',
              docStatus === 'conflict' || docStatus === 'error'
                ? 'text-foreground'
                : 'text-muted-foreground',
            )}
          >
            {statusText}
          </span>
        ) : viewOnly ? (
          <span className="text-muted-foreground max-w-40 min-w-0 shrink truncate px-2 text-xs">
            {t('viewOnly')}
          </span>
        ) : null}
        {artifact ? (
          <div className="flex shrink-0 items-center gap-2">
            {/* Who can open it, for every viewer, as the session header shows its people. */}
            {people ? (
              <SessionParticipantStack
                participants={people}
                label={t('peopleWithAccess', {
                  names: people.participants.map(participantLabel).filter(Boolean).join(', '),
                })}
              />
            ) : null}
            {/* Two groups: the artifact's history and Ask AI; then Share and More. */}
            <ButtonGroup>
              <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
                <Hint label={`${t('history')} · ${t('editedAgo', { time: relativeTime(artifact.updated_at, locale) })}`} side="bottom">
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="secondary" aria-label={t('history')}>
                      <ClockCounterClockwiseIcon className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </Hint>
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
                            <DropdownMenuItem
                              key={v.id}
                              onSelect={() => openVersion(current ? undefined : v.id)}
                              aria-current={viewing || undefined}
                            >
                              <span className="tabular-nums">
                                {new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(
                                  new Date(v.created_at),
                                )}
                              </span>
                              {v.saves > 1 ? (
                                <span className="text-muted-foreground text-xs tabular-nums">
                                  {t('saves', { count: v.saves })}
                                </span>
                              ) : null}
                              {current || viewing ? (
                                <span
                                  className={`ml-auto text-xs ${viewing && !current ? 'text-foreground' : 'text-muted-foreground'}`}
                                >
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
              {/* A narrow header (a small window, the session panel) moves Ask AI into ⋯. */}
              {canEdit && !compact ? (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => setAsking((open) => !open)}
                  aria-expanded={asking}
                  className="aria-expanded:bg-accent"
                >
                  <SparkleIcon weight="fill" className="size-3.5" aria-hidden /> {t('askAgent')}
                </Button>
              ) : null}
            </ButtonGroup>
            <ButtonGroup>
              {artifact.can_manage ? (
                compact ? (
                  <Hint label={t('share')} side="bottom">
                    <Button
                      size="icon-sm"
                      variant="secondary"
                      aria-label={t('share')}
                      onClick={() => setSharing(true)}
                    >
                      <ShareNetworkIcon className="size-3.5" aria-hidden />
                    </Button>
                  </Hint>
                ) : (
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => setSharing(true)}
                  >
                    <ShareNetworkIcon className="size-3.5" aria-hidden /> {t('share')}
                  </Button>
                )
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="secondary" aria-label={t('actions')}>
                    <DotsThreeIcon className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(e) => {
                    if (!renameFromMenu.current) return;
                    renameFromMenu.current = false;
                    e.preventDefault();
                    focusRename();
                  }}
                >
                  {canEdit && compact ? (
                    <DropdownMenuItem onSelect={() => setAsking(true)}>
                      <SparkleIcon weight="fill" /> {t('askAgent')}
                    </DropdownMenuItem>
                  ) : null}
                  {isDoc ? (
                    <DropdownMenuItem onSelect={exportPdf}>
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
                  <DropdownMenuItem
                    onSelect={() => window.open(artifact.version.view_url, '_blank', 'noopener')}
                  >
                    <ArrowSquareOutIcon /> {t('openNewTab')}
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link
                      href={`/workspaces/${projectId}/drive?path=${encodeURIComponent(drivePathToParam(folder, null))}`}
                    >
                      <FolderOpenIcon /> {t('openInFiles')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      mutations.pin.mutate({
                        artifactId: artifact.artifact_id,
                        pinned: !artifact.pinned,
                      })
                    }
                  >
                    {artifact.pinned ? <PushPinSlashIcon /> : <PushPinIcon />}{' '}
                    {artifact.pinned ? t('unpin') : t('pin')}
                  </DropdownMenuItem>
                  {artifact.can_manage ? (
                    <>
                      <DropdownMenuItem
                        onSelect={() => {
                          renameFromMenu.current = true;
                          startRename();
                        }}
                      >
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
          <ButtonGroup className="shrink-0 items-center">
            {/* `data-no-panel`: the session's link interceptor would reopen it in this panel. */}
            <Hint label={t('openFullPage')} side="bottom">
              <Button size="icon-sm" variant="ghost" aria-label={t('openFullPage')} asChild>
                <Link href={`/workspaces/${projectId}/artifacts/${artifactId}`} data-no-panel>
                  <ArrowsOutSimpleIcon className="size-3.5" />
                </Link>
              </Button>
            </Hint>
            <Hint label={t('close')} side="bottom">
              <Button size="icon-sm" variant="ghost" aria-label={t('close')} onClick={onClose}>
                <XIcon className="size-3.5" />
              </Button>
            </Hint>
          </ButtonGroup>
        ) : null}
      </header>

      {artifact && viewingOld ? (
        <div className="bg-muted flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs">
          <span className="min-w-0 truncate">
            {/* The version's own time (every save, not only a burst's newest); until the history
                answers, no time rather than a wrong one. */}
            {openedVersionAt
              ? t('viewingOld', { time: relativeTime(openedVersionAt, locale) })
              : t('viewingOldUndated')}
          </span>
          <span className="flex shrink-0 gap-1">
            <Button size="xs" variant="ghost" onClick={() => openVersion(undefined)}>
              {t('backToCurrent')}
            </Button>
            {artifact.can_edit ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={mutations.restore.isPending}
                aria-busy={mutations.restore.isPending}
                onClick={async () => {
                  await mutations.restore.mutateAsync({
                    artifactId: artifact.artifact_id,
                    version: version!,
                  });
                  openVersion(undefined);
                  successToast(t('restored'));
                }}
              >
                {mutations.restore.isPending ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <ArrowCounterClockwiseIcon />
                )}{' '}
                {t('restore')}
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}

      {/* Ask agent: a column beside the artifact with one session's chat (covers it when narrow). */}
      <SplitSheet
        open={asking && !!artifact}
        onOpenChange={setAsking}
        size="lg"
        className="h-auto min-h-0 flex-1"
      >
        <SplitSheetMain className="flex">
          <div className="flex min-h-0 min-w-0 flex-1">
            {!artifact ? (
              <div className="grid flex-1 place-items-center">
                <Loading className="size-4" />
              </div>
            ) : isDoc ? (
              <div
                ref={docScroller}
                className="bg-background min-w-0 flex-1 overflow-y-auto"
                onScroll={(event) => {
                  if (docScroll.current.ready) docScroll.current.top = event.currentTarget.scrollTop;
                }}
              >
                <DocEditor
                  // Read-only: a new file version opens a new editor (an editable one takes it in place).
                  key={docKey}
                  projectId={projectId}
                  artifact={artifact}
                  editable={canEdit}
                  onStatus={setDocStatus}
                  onReload={reloadDoc}
                  onReady={restoreDocScroll}
                />
              </div>
            ) : (
              <div className="bg-muted relative min-w-0 flex-1">
                {viewUrl ? (
                  <ArtifactFrame
                    ref={frame}
                    frameKey={frameKey!}
                    src={viewUrl}
                    title={artifact.title}
                    className="absolute inset-0 size-full border-0"
                  />
                ) : (
                  <div className="grid h-full place-items-center">
                    <Loading className="size-4" />
                  </div>
                )}
              </div>
            )}
          </div>
        </SplitSheetMain>
        {artifact ? (
          <AskAgentSheet
            projectId={projectId}
            artifact={artifact}
            onAgentWork={() => void query.refetch()}
          />
        ) : null}
      </SplitSheet>

      {artifact && sharing ? (
        <ShareArtifactDialog
          projectId={projectId}
          artifact={artifact}
          open
          onOpenChange={setSharing}
        />
      ) : null}
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
          else router.push(`/workspaces/${projectId}/artifacts`);
        }}
      />
    </div>
  );
}
