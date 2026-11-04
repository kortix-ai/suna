'use client';

import {
  readArtifactCommentSnapshot,
  type ArtifactCommentAnchor,
  type ArtifactVersion,
} from '@kortix/sdk';
import {
  useArtifact,
  useArtifactCommentContext,
  useArtifactComments,
  useArtifactMutations,
  useArtifactVersions,
  useFeatureFlag,
  useInfiniteArtifactActivity,
} from '@kortix/sdk/react';
import { ARTIFACT_TEXT_QUOTE_MAX } from '@kortix/shared/artifact-comments';
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
import { CountBadge } from '@kortix/ui/count-badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { ErrorState } from '@kortix/ui/error-state';
import Hint from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import Loading from '@kortix/ui/loading';
import {
  SessionParticipantStack,
  participantLabel,
} from '@kortix/ui/session/participants/session-participants';
import { useOptionalSidebar } from '@kortix/ui/sidebar';
import { Skeleton } from '@kortix/ui/skeleton';
import { SplitSheet, SplitSheetMain } from '@kortix/ui/split-sheet';
import { successToast } from '@kortix/ui/toast';
import { SidebarToggle } from '@kortix/ui/workspace';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  CaretRightIcon,
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  CornersOutIcon,
  DotsThreeIcon,
  FilePdfIcon,
  FolderOpenIcon,
  MapPinIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ScribbleIcon,
  ShareNetworkIcon,
  SparkleIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { drivePathToParam } from '@kortix/ui/files';
import { useAuth } from '@/features/providers/auth-provider';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { ArtifactFrame, artifactFrameKey, printArtifact } from '@kortix/ui/artifacts';
import { ArtifactDiscussionLayout } from './artifact-discussion-layout';
import { threadDeleted } from './artifact-discussion-logic';
import {
  ArtifactDiscussionSidebar,
  useArtifactDiscussionState,
} from './artifact-discussion-sidebar';
import type { DrawingStroke } from './artifact-drawing';
import { ArtifactDrawingCanvas } from './artifact-drawing-canvas';
import { prepareDrawingDraft, type ArtifactDrawingDraft } from './artifact-drawing-draft';
import { ArtifactDrawingLayer } from './artifact-drawing-layer';
import { VISIBILITY_ICON, relativeTime } from './artifact-meta';
import {
  ArtifactSelectionChip,
  isCommentShortcut,
  nextSelectionOffer,
  selectionOfferKey,
} from './artifact-selection-chip';
import { AskAgentSheet } from './ask-agent-sheet';
import { DocEditor, type DocSaveStatus } from './doc-editor';
import { ShareArtifactDialog } from './share-artifact-dialog';
import {
  useArtifactAnnotations,
  type ArtifactAnnotationSelection,
  type ArtifactAnnotationViewport,
} from './use-artifact-annotations';
import { useArtifactSelectionCapture } from './use-artifact-selection-capture';
import { useArtifactUnshare } from './use-artifact-unshare';
import { rootRem, useElementWidth } from './use-element-width';

/** A pressed mode toggle (pin, draw) in the header's secondary group: inverted ink, so the mode reads at a glance. */
const MODE_TOGGLE =
  'aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground/90';

/** An anchor's identity: it equals the key of an offer of the same selection. */
const anchorKey = (anchor: ArtifactCommentAnchor | null | undefined) =>
  anchor ? JSON.stringify(anchor) : '';

/** A keyboard target that owns Escape itself: a field, or an open dialog, menu or list. */
function ownsEscape(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]') ||
    !!target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
  );
}

/** The page's key reached the parent only with a real keypress: `userActivation` proves one. */
function userActivated(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return activation ? activation.isActive : true;
}

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
 * /projects/[id]/artifacts/[artifactId] — one artifact, full height. A doc is
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
  const search = useSearchParams();
  const viewerId = useAuth().user?.id;
  const [version, setVersion] = useState<string | undefined>(undefined);
  const selection = useArtifactSelectionCapture();
  const clearSelection = selection.clear;
  const query = useArtifact(projectId, artifactId, version);
  const artifact = query.data;
  const mutations = useArtifactMutations(projectId);
  const frame = useRef<HTMLDivElement>(null);
  const [claimedFrame, setClaimedFrame] = useState<HTMLIFrameElement | null>(null);
  const [annotationMode, setAnnotationMode] = useState<'text' | 'comment'>('text');
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [drawingBusy, setDrawingBusy] = useState(false);
  const [drawingError, setDrawingError] = useState(false);
  const [drawingViewport, setDrawingViewport] = useState<ArtifactAnnotationViewport | null>(null);
  const [pendingDrawing, setPendingDrawing] = useState<ArtifactDrawingDraft | null>(null);
  // The canvas has a stroke: from then on the drawing keeps its viewport and a layout change is stale.
  const [drawingDirty, setDrawingDirty] = useState(false);
  // A text selection the page offers: the Comment chip. Selecting text never opens the panel.
  const [offer, setOffer] = useState<ArtifactAnnotationSelection | null>(null);
  // The offer the person dismissed (Escape, a click elsewhere): the page sends it again after a
  // layout, and it stays hidden until the page reports a new gesture (`nextSelectionOffer`).
  const dismissedOffer = useRef('');
  // The passage the page itself sent to the composer (its ⌘⌥M). Its composer shows without
  // keyboard focus: the page can forge the key, and the person may be typing in a page form.
  const [pageOpenedAnchor, setPageOpenedAnchor] = useState<ArtifactCommentAnchor | null>(null);
  const chip = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const pinButton = useRef<HTMLButtonElement>(null);
  const drawButton = useRef<HTMLButtonElement>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const commentsButton = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headerWidth = useElementWidth(header);
  const rem = headerWidth === null ? 16 : rootRem();
  // Below `sm` (40rem) the header has room for its essentials only: Pin and Draw move into ⋯.
  const compact = headerWidth !== null && headerWidth < 40 * rem;
  // Below 48rem the discussion covers the page (ArtifactDiscussionLayout `cover`) instead of narrowing it.
  const coverLayout = headerWidth !== null && headerWidth < 48 * rem;
  const drawingRequest = useRef(0);
  const invalidateDrawingRequest = useCallback(() => {
    drawingRequest.current++;
  }, []);
  const [docStatus, setDocStatus] = useState<DocSaveStatus>('saved');
  // Bumped by a conflict's Reload: the editor opens again on the version now in Files.
  const [reloads, setReloads] = useState(0);
  const reloadDoc = () => {
    selection.clear();
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
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const versions = useArtifactVersions(projectId, artifactId, historyOpen);
  const viewingOld = !!artifact?.version.id;
  const canEdit = !!artifact?.can_edit && !viewingOld;
  const isDoc = artifact?.type === 'doc';
  const sidebar = useOptionalSidebar();
  const commentsFlag = useFeatureFlag(projectId, 'artifact_comments').enabled;
  const artifactsFlag = useFeatureFlag(projectId, 'artifacts').enabled;
  const discussionEnabled = commentsFlag && artifactsFlag;
  const comments = useArtifactComments(projectId, artifactId, {
    status: 'all',
    version,
    enabled: discussionEnabled,
  });
  const context = useArtifactCommentContext(projectId, artifactId, {
    version,
    enabled: discussionEnabled,
  });
  const annotationVersion =
    discussionEnabled && artifact && !isDoc ? context.data?.version.commit_id : null;
  const annotated = useArtifact(
    annotationVersion ? projectId : null,
    annotationVersion ? artifactId : null,
    annotationVersion ?? undefined,
  );
  const annotationEnabled = !!annotationVersion;
  const annotatedUrl = annotationEnabled ? annotated.data?.version.view_url : null;
  const viewUrl = annotatedUrl
    ? (() => {
        const url = new URL(annotatedUrl);
        url.searchParams.set('annotate', '1');
        return url.toString();
      })()
    : annotationEnabled
      ? null
      : artifact?.version.view_url;
  const frameKey = artifact
    ? artifactFrameKey(
        artifact,
        annotationEnabled ? annotationVersion : artifact.version.id,
        annotationEnabled,
      )
    : null;
  const removal = useArtifactUnshare(
    discussionEnabled
      ? async () => {
          const fresh = await context.refetch();
          if (fresh.isError || !fresh.data) throw new Error('Comment count unavailable');
          return fresh.data.comment_count;
        }
      : undefined,
  );
  const activity = useInfiniteArtifactActivity(projectId, artifactId, {
    enabled: discussionEnabled,
  });
  const discussionState = useArtifactDiscussionState();
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const defaultPanel = useRef('');
  const scope = `${projectId}:${artifactId}`;
  const pendingAnchor = selection.anchor;
  const openVersion = (next: string | undefined) => {
    selection.clear();
    setAnnotationMode('text');
    setVersion(next);
  };
  const openComments = (comments.data ?? []).filter(
    (thread) => thread.status === 'open' && !threadDeleted(thread),
  ).length;
  useEffect(() => {
    if (!discussionEnabled || !comments.data || defaultPanel.current === scope) return;
    defaultPanel.current = scope;
    setDiscussionOpen(openComments > 0);
  }, [discussionEnabled, comments.data, scope, openComments]);
  const focusThread = useCallback(
    (threadId: string) => {
      defaultPanel.current = scope;
      if (version && !comments.data?.some((thread) => thread.thread_id === threadId)) {
        clearSelection();
        setVersion(undefined);
      }
      setFocusedThreadId(threadId);
      setFocusRevision((revision) => revision + 1);
      setDiscussionOpen(true);
    },
    [scope, version, comments.data, clearSelection],
  );
  /**
   * Open the composer on an anchor the person chose: a pin, a region, or the Comment chip.
   * `fromPage`: the page's shortcut chose it, so the composer does not take keyboard focus.
   */
  const commentOn = (anchor: ArtifactCommentAnchor, fromPage = false) => {
    setOffer(null);
    setPendingDrawing(null);
    selection.begin();
    if (!selection.publish(anchor)) return;
    setPageOpenedAnchor(fromPage ? anchor : null);
    defaultPanel.current = scope;
    setDiscussionOpen(true);
  };
  const dismissOffer = () => {
    if (!offer) return false;
    dismissedOffer.current = selectionOfferKey(offer);
    setOffer(null);
    return true;
  };
  const focusSoon = (target: HTMLElement | null) =>
    requestAnimationFrame(() => target?.focus({ preventScroll: true }));
  const htmlAnnotations = useArtifactAnnotations({
    enabled: annotationEnabled,
    frame: claimedFrame,
    slot: frame,
    version: annotationVersion,
    canComment: context.data?.can_comment === true && !version,
    mode: annotationMode,
    drawing: drawingOpen,
    threads: comments.data,
    focusedThreadId,
    focusRevision,
    // Comment mode: a pin or a region is an explicit request to comment there.
    onCandidate: (anchor) => {
      if (!drawingOpen) commentOn(anchor);
    },
    // Text mode: a selection only offers the Comment chip. The panel opens on the chip or ⌘⌥M.
    onSelection: (next, moved) => {
      const result = nextSelectionOffer(
        next,
        moved === true,
        dismissedOffer.current,
        (key) => drawingOpen || key === anchorKey(selection.anchor),
      );
      dismissedOffer.current = result.dismissed;
      setOffer(result.offer);
    },
    // Anything in the page can post these keys. Escape only leaves the chip or pin mode, and a
    // composer the shortcut opens shows without keyboard focus.
    onKey: (key) => {
      if (key === 'escape') escapeAnnotation(true);
      else if (offer?.state === 'candidate' && userActivated()) commentOn(offer.anchor, true);
    },
    onFocus: focusThread,
    // The page hears "Comment 3": one UI word and the number, never the comment.
    pinLabel: (n) => t('discussion.pagePinLabel', { number: String(n) }),
  });
  const clearCommentSelection = (expected?: ArtifactCommentAnchor) => {
    selection.clear(expected);
    setPendingDrawing((current) => (!expected || current?.anchor === expected ? null : current));
  };
  const cancelDrawing = () => {
    drawingRequest.current++;
    htmlAnnotations.cancelCapture();
    setDrawingOpen(false);
    setDrawingBusy(false);
    setDrawingError(false);
    setDrawingViewport(null);
    setDrawingDirty(false);
    selection.clear();
  };
  /** Draw mode docks the panel first: a panel opened after the drawing would narrow the page and hide it. */
  const startDrawing = () => {
    clearCommentSelection();
    setOffer(null);
    setAnnotationMode('text');
    setDrawingError(false);
    setDrawingDirty(false);
    setDrawingViewport(null);
    setDrawingOpen(true);
    defaultPanel.current = scope;
    // Beside the page the panel opens now; over the page (`cover`) it closes, so the page is in reach.
    if (coverLayout) setDiscussionOpen(false);
    else if (!discussionOpen) setDiscussionOpen(true);
  };
  const togglePinMode = () => {
    setOffer(null);
    if (annotationMode === 'text' && coverLayout) {
      defaultPanel.current = scope;
      setDiscussionOpen(false);
    }
    setAnnotationMode((mode) => (mode === 'comment' ? 'text' : 'comment'));
  };
  /**
   * Escape, from the parent or the page: the chip, then draw mode, then pin mode. Focus returns to
   * the mode's button. `fromPage`: the drawing layer covers the page and handles its own Escape,
   * so an Escape from the page is forged there and the strokes stay.
   */
  const escapeAnnotation = (fromPage = false): boolean => {
    if (dismissOffer()) return true;
    if (drawingOpen) {
      if (fromPage) return false;
      cancelDrawing();
      focusSoon(compact ? actionsButton.current : drawButton.current);
      return true;
    }
    if (annotationMode === 'comment') {
      setAnnotationMode('text');
      focusSoon(compact ? actionsButton.current : pinButton.current);
      return true;
    }
    return false;
  };
  // Until the first stroke the drawing follows the page: it takes the layout the page reports at
  // the frame's current size, so docking the panel never leaves a stale canvas.
  const annotationViewport = htmlAnnotations.viewport;
  useEffect(() => {
    if (!drawingOpen || drawingDirty || !annotationViewport || !claimedFrame) return;
    if (annotationViewport === drawingViewport) return;
    if (
      Math.abs(claimedFrame.clientWidth - annotationViewport.width) > 1 ||
      Math.abs(claimedFrame.clientHeight - annotationViewport.height) > 1
    )
      return;
    setDrawingViewport(annotationViewport);
  }, [drawingOpen, drawingDirty, annotationViewport, drawingViewport, claimedFrame]);
  // The parent's own keys: ⌘⌥M comments on the offered selection; Escape leaves the chip, draw
  // mode and pin mode. A field, dialog or menu keeps its own Escape.
  const onKeys = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (isCommentShortcut(event) && offer?.state === 'candidate') {
      event.preventDefault();
      commentOn(offer.anchor);
    } else if (event.key === 'Escape' && !ownsEscape(event.target) && escapeAnnotation()) {
      event.preventDefault();
    }
  };
  const keys = useRef(onKeys);
  const dismiss = useRef(dismissOffer);
  useLayoutEffect(() => {
    keys.current = onKeys;
    dismiss.current = dismissOffer;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // A press anywhere in the app outside the chip dismisses it. A press in the page reaches the
  // bridge instead, which reports the selection gone or changed.
  const hasOffer = !!offer;
  useEffect(() => {
    if (!hasOffer) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!chip.current?.contains(event.target as Node)) dismiss.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [hasOffer]);
  const cancelCapture = htmlAnnotations.cancelCapture;
  useLayoutEffect(() => {
    invalidateDrawingRequest();
    cancelCapture();
    setDrawingOpen(false);
    setDrawingBusy(false);
    setDrawingError(false);
    setDrawingViewport(null);
    setDrawingDirty(false);
    setPendingDrawing(null);
    setOffer(null);
    dismissedOffer.current = '';
    clearSelection();
    return invalidateDrawingRequest;
  }, [
    annotationVersion,
    claimedFrame,
    version,
    context.data?.can_comment,
    cancelCapture,
    clearSelection,
    invalidateDrawingRequest,
  ]);
  const finishDrawing = async (strokes: DrawingStroke[]) => {
    if (drawingBusy || !drawingViewport) return;
    if (!htmlAnnotations.isCurrentViewport(drawingViewport)) {
      setDrawingError(true);
      return;
    }
    const request = ++drawingRequest.current;
    setDrawingBusy(true);
    setDrawingError(false);
    selection.begin();
    const drawing = await prepareDrawingDraft(strokes, drawingViewport, htmlAnnotations);
    if (drawingRequest.current !== request) return;
    setDrawingBusy(false);
    if (!drawing || !htmlAnnotations.isCurrentViewport(drawingViewport)) {
      selection.clear();
      setDrawingError(true);
      return;
    }
    if (!selection.publish(drawing.anchor)) return;
    setPendingDrawing(drawing);
    setDrawingOpen(false);
    defaultPanel.current = scope;
    setDiscussionOpen(true);
  };
  const requestedThread = search.get('thread');
  const requestedFocus = useRef('');
  useEffect(() => {
    const key = `${scope}:${requestedThread ?? ''}`;
    if (!discussionEnabled || !requestedThread || requestedFocus.current === key) return;
    requestedFocus.current = key;
    focusThread(requestedThread);
  }, [discussionEnabled, scope, requestedThread, focusThread]);
  const readCommentSnapshot = useCallback(
    () => readArtifactCommentSnapshot(projectId, artifactId),
    [projectId, artifactId],
  );
  const changeDiscussionOpen = (open: boolean) => {
    defaultPanel.current = scope;
    if (!open && selection.status === 'pending') selection.clear();
    // The panel closes from inside (its close button, Escape): the keyboard returns to the toggle.
    if (!open && discussionOpen) {
      const focused = document.activeElement;
      const inside = !!focused && !!document.getElementById(panelId)?.contains(focused);
      if (inside || !focused || focused === document.body) focusSoon(commentsButton.current);
    }
    setDiscussionOpen(open);
  };
  const discussion =
    artifact && discussionEnabled ? (
      // The panel's id: the header toggle's `aria-controls`.
      <div id={panelId} className="flex h-full min-h-0 flex-1 flex-col">
        <ArtifactDiscussionSidebar
          projectId={projectId}
          artifact={artifact}
          comments={comments}
          displayThreads={annotationEnabled ? htmlAnnotations.threads : undefined}
          pinNumbers={annotationEnabled ? htmlAnnotations.pinNumbers : undefined}
          context={context.data}
          contextLoading={context.isLoading}
          contextError={context.isError}
          onRetryContext={() => void context.refetch()}
          activity={{
            items: activity.items,
            isLoading: activity.isLoading,
            isError: activity.isError,
            hasNextPage: activity.hasNextPage,
            isFetchingNextPage: activity.isFetchingNextPage,
            olderVersions: activity.olderVersions,
            onLoadMore: () => void activity.fetchNextPage(),
            onRetry: () => void activity.refetch(),
          }}
          focusedThreadId={focusedThreadId}
          focusRevision={focusRevision}
          onFocusThread={focusThread}
          pendingAnchor={pendingAnchor}
          pageOpenedAnchor={pageOpenedAnchor}
          pendingDrawing={pendingDrawing}
          onClearAnchor={clearCommentSelection}
          selectionCapture={selection.status}
          readOnly={!!version}
          onOpenVersion={openVersion}
          state={discussionState}
        />
      </div>
    ) : null;

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
  const folder = artifact
    ? artifact.path.endsWith(`/${artifact.entry}`)
      ? artifact.path.slice(0, -artifact.entry.length - 1)
      : artifact.path
    : '';
  const rows = historyRows(versions.data ?? []);
  const people = artifact?.participants;
  // Pin and Draw: an HTML page the person may comment on, at its current version.
  const annotationControls = annotationEnabled && context.data?.can_comment === true && !version;
  const annotationReady = htmlAnnotations.status === 'ready';
  const pinMode = annotationMode === 'comment' && annotationReady;
  const notReadyHint =
    htmlAnnotations.status === 'loading'
      ? t('discussion.annotationLoading')
      : t('discussion.annotationUnavailable', { refresh: t('refresh'), actions: t('actions') });
  const pinHint = annotationReady ? t('discussion.annotationModeHint') : notReadyHint;
  const drawHint = annotationReady || drawingOpen ? t('discussion.draw') : notReadyHint;
  const commentsLabel =
    openComments > 0
      ? t(discussionOpen ? 'discussion.hidePanelCount' : 'discussion.showPanelCount', {
          count: openComments,
        })
      : t(discussionOpen ? 'discussion.hidePanel' : 'discussion.showPanel');
  const selectionChip =
    offer &&
    annotationReady &&
    annotationMode === 'text' &&
    !drawingOpen &&
    htmlAnnotations.viewport
      ? offer
      : null;

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
                        if (title && title !== artifact.title)
                          await mutations.update.mutateAsync({
                            artifactId: artifact.artifact_id,
                            title,
                          });
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
                <Hint label={t(`visibility.${artifact.visibility}`)}>
                  <span
                    className="text-muted-foreground flex shrink-0"
                    aria-label={t(`visibility.${artifact.visibility}`)}
                  >
                    <VisIcon weight="fill" className="size-3.5" aria-hidden />
                  </span>
                </Hint>
              ) : null}
              {artifact?.pinned ? (
                <Hint label={t('pinned')}>
                  <span className="text-muted-foreground flex shrink-0" aria-label={t('pinned')}>
                    <PushPinIcon weight="fill" className="size-3.5" aria-hidden />
                  </span>
                </Hint>
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
                label={t('peopleWithAccess', {
                  names: people.participants.map(participantLabel).filter(Boolean).join(', '),
                })}
              />
            ) : null}
            {/* Two groups: the artifact's history and Ask AI; then Share and More. */}
            <ButtonGroup>
              <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
                <Hint label={t('editedAgo', { time: relativeTime(artifact.updated_at, locale) })}>
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
              {canEdit ? (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => setAsking((open) => !open)}
                  aria-expanded={asking}
                  className="aria-expanded:bg-accent hidden sm:inline-flex"
                >
                  <SparkleIcon weight="fill" className="size-3.5" aria-hidden /> {t('askAgent')}
                </Button>
              ) : null}
            </ButtonGroup>
            {/* The discussion group: pin, draw (wide header only), and the comments panel. Pin and
                Draw stay focusable while the page loads (aria-disabled), so their hint explains why. */}
            {discussionEnabled ? (
              <ButtonGroup>
                {annotationControls && !compact ? (
                  <Hint label={pinHint}>
                    <Button
                      ref={pinButton}
                      size="icon-sm"
                      variant="secondary"
                      aria-label={t('discussion.annotationMode')}
                      aria-pressed={pinMode}
                      aria-busy={htmlAnnotations.status === 'loading'}
                      aria-disabled={!annotationReady || undefined}
                      className={cn(MODE_TOGGLE, 'aria-disabled:opacity-50')}
                      onClick={() => {
                        if (annotationReady) togglePinMode();
                      }}
                    >
                      {htmlAnnotations.status === 'loading' ? (
                        <Loading className="size-3.5" />
                      ) : (
                        <MapPinIcon className="size-3.5" aria-hidden />
                      )}
                    </Button>
                  </Hint>
                ) : null}
                {annotationControls && !compact ? (
                  <Hint label={drawHint}>
                    <Button
                      ref={drawButton}
                      size="icon-sm"
                      variant="secondary"
                      aria-label={t('discussion.draw')}
                      aria-pressed={drawingOpen}
                      aria-disabled={(!annotationReady && !drawingOpen) || undefined}
                      className={cn(MODE_TOGGLE, 'aria-disabled:opacity-50')}
                      onClick={() => {
                        if (drawingOpen) cancelDrawing();
                        else if (annotationReady) startDrawing();
                      }}
                    >
                      <ScribbleIcon className="size-3.5" aria-hidden />
                    </Button>
                  </Hint>
                ) : null}
                <Hint label={commentsLabel}>
                  <Button
                    ref={commentsButton}
                    size={openComments > 0 ? 'xs' : 'icon-sm'}
                    variant="secondary"
                    aria-label={commentsLabel}
                    aria-expanded={discussionOpen}
                    aria-controls={discussionOpen ? panelId : undefined}
                    onClick={() => changeDiscussionOpen(!discussionOpen)}
                  >
                    <ChatCircleIcon className="size-3.5" aria-hidden />
                    {openComments > 0 ? (
                      <CountBadge count={openComments} tone="waiting" aria-hidden />
                    ) : null}
                  </Button>
                </Hint>
              </ButtonGroup>
            ) : null}
            <ButtonGroup>
              {artifact.can_manage ? (
                compact ? (
                  <Hint label={t('share')}>
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
                  <Button size="xs" variant="secondary" onClick={() => setSharing(true)}>
                    <ShareNetworkIcon className="size-3.5" aria-hidden /> {t('share')}
                  </Button>
                )
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    ref={actionsButton}
                    size="icon-sm"
                    variant="secondary"
                    aria-label={t('actions')}
                  >
                    <DotsThreeIcon className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {annotationControls && compact ? (
                    <>
                      <DropdownMenuCheckboxItem
                        reverse
                        checked={pinMode}
                        disabled={!annotationReady}
                        onCheckedChange={togglePinMode}
                      >
                        <MapPinIcon /> {t('discussion.annotationMode')}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem
                        reverse
                        checked={drawingOpen}
                        disabled={!annotationReady && !drawingOpen}
                        onCheckedChange={() => (drawingOpen ? cancelDrawing() : startDrawing())}
                      >
                        <ScribbleIcon /> {t('discussion.draw')}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
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
                    <DropdownMenuItem
                      onSelect={() => {
                        htmlAnnotations.reset();
                        reloadFrame(frameKey, viewUrl);
                      }}
                    >
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
                      href={`/projects/${projectId}/drive?path=${encodeURIComponent(drivePathToParam(folder, null))}`}
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
                      <DropdownMenuItem onSelect={() => setRenaming(true)}>
                        <PencilSimpleIcon /> {t('rename')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => void removal.prepare()}
                      >
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
            {/* `data-no-panel`: the session's link interceptor would reopen it in this panel. */}
            <Hint label={t('openFullPage')}>
              <Button size="icon-sm" variant="ghost" aria-label={t('openFullPage')} asChild>
                <Link href={`/projects/${projectId}/artifacts/${artifactId}`} data-no-panel>
                  <ArrowsOutSimpleIcon className="size-3.5" />
                </Link>
              </Button>
            </Hint>
            <Hint label={t('close')}>
              <Button size="icon-sm" variant="ghost" aria-label={t('close')} onClick={onClose}>
                <XIcon className="size-3.5" />
              </Button>
            </Hint>
          </div>
        ) : null}
      </header>

      {artifact && viewingOld ? (
        <div className="bg-muted flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs">
          <span>
            {t('viewingOld', {
              time: relativeTime(
                rows.find((r) => r.id === version)?.created_at ?? artifact.updated_at,
                locale,
              ),
            })}
          </span>
          <span className="flex gap-1">
            <Button size="xs" variant="ghost" onClick={() => openVersion(undefined)}>
              {t('backToCurrent')}
            </Button>
            {artifact.can_edit ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={mutations.restore.isPending}
                onClick={async () => {
                  await mutations.restore.mutateAsync({
                    artifactId: artifact.artifact_id,
                    version: version!,
                  });
                  openVersion(undefined);
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
      <SplitSheet
        open={asking && !!artifact}
        onOpenChange={setAsking}
        size="lg"
        className="h-auto min-h-0 flex-1"
      >
        <SplitSheetMain className="flex">
          <ArtifactDiscussionLayout
            open={discussionEnabled && discussionOpen}
            onOpenChange={changeDiscussionOpen}
            embedded={embedded}
            viewerId={viewerId}
            title={t('discussion.panelTitle')}
            closeLabel={t('close')}
            resizeLabel={t('discussion.resizePanel')}
            discussion={discussion}
          >
            {!artifact ? (
              <div className="grid flex-1 place-items-center">
                <Loading className="size-4" />
              </div>
            ) : isDoc ? (
              <div className="bg-background min-w-0 flex-1 overflow-y-auto">
                <DocEditor
                  // Read-only: a new file version opens a new editor (an editable one takes it in place).
                  key={`${artifact.artifact_id}:${artifact.version.id ?? 'now'}:${reloads}${canEdit || viewingOld ? '' : `:${artifact.entry_version}`}`}
                  projectId={projectId}
                  artifact={artifact}
                  editable={canEdit}
                  onStatus={setDocStatus}
                  onReload={reloadDoc}
                  comments={discussionEnabled ? comments.data : undefined}
                  commentEntryVersion={context.data?.version.entry_version}
                  focusedThreadId={focusedThreadId}
                  focusRevision={focusRevision}
                  onFocusThread={discussionEnabled ? focusThread : undefined}
                  canComment={discussionEnabled && context.data?.can_comment === true && !version}
                  historical={!!version}
                  onCommentStart={() => {
                    const finish = selection.begin();
                    changeDiscussionOpen(true);
                    return finish;
                  }}
                  onComment={(anchor) => {
                    if (!selection.publish(anchor)) return;
                    changeDiscussionOpen(true);
                  }}
                  readCommentSnapshot={discussionEnabled ? readCommentSnapshot : undefined}
                />
              </div>
            ) : (
              <div className="bg-muted relative min-w-0 flex-1">
                {annotationEnabled && annotated.isError ? (
                  <div className="grid h-full place-items-center p-4">
                    <ErrorState
                      title={t('discussion.contextLoadError')}
                      action={
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void annotated.refetch()}
                        >
                          {t('discussion.retry')}
                        </Button>
                      }
                    />
                  </div>
                ) : viewUrl ? (
                  <ArtifactFrame
                    ref={frame}
                    onFrame={setClaimedFrame}
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
                {annotationEnabled ? (
                  <ArtifactDrawingLayer
                    viewport={htmlAnnotations.viewport}
                    regions={htmlAnnotations.regions}
                    threads={htmlAnnotations.threads}
                    focusedThreadId={focusedThreadId}
                  />
                ) : null}
                {drawingOpen && drawingViewport ? (
                  <ArtifactDrawingCanvas
                    viewport={htmlAnnotations.viewport ?? drawingViewport}
                    busy={drawingBusy}
                    stale={htmlAnnotations.viewport !== drawingViewport}
                    labels={{
                      canvas: t('discussion.draw'),
                      pen: t('discussion.drawPen'),
                      arrow: t('discussion.drawArrow'),
                      rectangle: t('discussion.drawRectangle'),
                      black: t('discussion.drawBlack'),
                      red: t('discussion.drawRed'),
                      blue: t('discussion.drawBlue'),
                      undo: t('discussion.drawUndo'),
                      finish: t('discussion.postComment'),
                      cancel: t('discussion.cancel'),
                      pageChanged: t('discussion.drawPageChanged'),
                      limit: t('discussion.drawLimit'),
                    }}
                    onFinish={(strokes) => void finishDrawing(strokes)}
                    onDraftChange={setDrawingDirty}
                    onCancel={() => {
                      cancelDrawing();
                      focusSoon(compact ? actionsButton.current : drawButton.current);
                    }}
                  />
                ) : null}
                {drawingOpen && drawingError ? (
                  // A floating surface over the page: the banner's tint needs an opaque ground.
                  <div className="bg-popover absolute inset-x-3 top-3 rounded-md shadow-md">
                    <InfoBanner
                      tone="warning"
                      icon={WarningIcon}
                      title={t('discussion.drawPageChanged')}
                    />
                  </div>
                ) : null}
                {selectionChip ? (
                  <ArtifactSelectionChip
                    ref={chip}
                    rect={selectionChip.rect}
                    frame={htmlAnnotations.viewport!}
                    label={
                      selectionChip.state === 'candidate'
                        ? t('discussion.commentSelection')
                        : t('discussion.selectionTooLong', { max: ARTIFACT_TEXT_QUOTE_MAX })
                    }
                    hint={t('discussion.commentSelectionHint')}
                    onComment={
                      selectionChip.state === 'candidate'
                        ? () => commentOn(selectionChip.anchor)
                        : undefined
                    }
                  />
                ) : null}
              </div>
            )}
          </ArtifactDiscussionLayout>
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
        open={removal.open}
        onOpenChange={(open) => {
          if (!open) removal.close();
        }}
        title={t('removeTitle')}
        description={
          <div className="space-y-3">
            <p>{t('removeHint')}</p>
            {removal.status === 'loading' ? <Loading className="size-4" /> : null}
            {removal.status === 'error' ? (
              <ErrorState
                size="sm"
                title={t('discussion.commentsLoadError')}
                action={
                  <Button size="sm" variant="outline" onClick={() => void removal.prepare()}>
                    {t('discussion.retry')}
                  </Button>
                }
              />
            ) : null}
            {discussionEnabled && removal.status === 'ready' && removal.count > 0 ? (
              <p>{t('discussion.unshareComments', { count: removal.count })}</p>
            ) : null}
          </div>
        }
        confirmLabel={t('remove')}
        confirmVariant="destructive"
        isPending={mutations.remove.isPending}
        confirmDisabled={removal.status !== 'ready'}
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
