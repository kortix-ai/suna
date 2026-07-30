'use client';

import { useTranslations } from 'next-intl';

import { sessionDisplayLabel } from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import Loading from '@/components/ui/loading';
import { useSidebar } from '@/components/ui/sidebar';
import { errorToast, successToast } from '@/components/ui/toast';
import { CompactModal } from '@/features/session/header/compact-modal';
import { ExportTranscriptModal } from '@/features/session/header/export-transcript-modal';
import { SessionChangesIndicator } from '@/features/session/header/session-changes-indicator';
import { SessionPendingApprovalsIndicator } from '@/features/session/header/session-pending-approvals-indicator';
import { openSessionQuickView } from '@/features/session/open-session-quick-view';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/project-sidebar/modal/share-session-modal';
import { desktopPlatform, isDesktop } from '@/lib/desktop';
import { track } from '@/lib/track';
import { cn } from '@/lib/utils';
import { useReadyChip, type QuickView } from '@/stores/kortix-computer-store';
import { listProjectSessions, restartProjectSession, stopProjectSession } from '@kortix/sdk';
import {
  CodeSimpleIcon as Code2,
  FileArrowDownIcon as FileDown,
  FolderOpenIcon as FolderOpen,
  GlobeIcon as Globe,
  HouseIcon,
  StackIcon as Layers,
  DotsThreeIcon as MoreHorizontal,
  SidebarSimpleIcon as PanelLeft,
  SidebarSimpleIcon as PanelRight,
  PencilSimpleIcon,
  ArrowCounterClockwiseIcon as RotateCcw,
  ShareIcon as Share,
  SquareIcon as Square,
  TerminalWindowIcon as SquareTerminal,
  TrashIcon as TrashSolid,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

/** Sandbox surfaces reachable from the header. One list drives both the
 *  desktop segment and the mobile sheet, so growing to 4-5 is a one-line add.
 *  Every entry fires the same `openSessionQuickView(view, 'header')` call. */
const DEV_TOOLS: {
  view: QuickView;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { view: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { view: 'browser', label: 'Browser', Icon: Globe },
  { view: 'files', label: 'Files', Icon: FolderOpen },
];

interface SessionSiteHeaderProps {
  sessionId: string;
  sessionTitle: string;
  onToggleSidePanel: () => void;
  isSidePanelOpen?: boolean;
  isMobileView?: boolean;
  leadingAction?: React.ReactNode;
}

export function SessionSiteHeader({
  sessionId,
  sessionTitle,
  onToggleSidePanel,
  isSidePanelOpen = false,
  isMobileView,
  leadingAction,
}: SessionSiteHeaderProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  // Desktop shell with the sidebar hidden (offcanvas): this header reaches the
  // window's left edge, where the macOS traffic lights and the shell's
  // "Open sidebar" toggle (fixed at x 72–100) live — indent the leading
  // buttons past both and drop them onto the same center line (y≈26).
  const {
    state: sidebarState,
    toggleSidebar,
    peek,
    peekEnter,
    peekLeave,
    isMobile: isMobileViewport,
  } = useSidebar();
  const [desktopShell] = useState<'macos' | 'other' | null>(() =>
    isDesktop() ? (desktopPlatform() === 'macos' ? 'macos' : 'other') : null,
  );
  const sidebarHidden = desktopShell !== null && sidebarState === 'collapsed';
  const sidebarToggleLabel =
    sidebarState === 'expanded' ? 'Collapse sidebar' : peek ? 'Pin sidebar' : 'Open sidebar';
  // Desktop: this toggle only exists to bring a hidden panel BACK — the
  // collapse control now lives in the panel's own header (ProjectSidebar).
  // Two toggles for one panel is one too many, so it self-hides while docked.
  // Mobile is untouched: `sidebarState` there tracks the desktop cookie, not
  // the Sheet, so gating on it would strand the only way to open the sheet.
  const showSidebarToggle =
    desktopShell === null && (isMobileViewport || sidebarState !== 'expanded');

  const [exportOpen, setExportOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Lifecycle actions (Share / Restart / Delete) operate on the project-level
  // session, which is only addressable on the `/projects/:id/sessions/:id` route.
  const projectRoute = pathname?.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)/);
  const projectId = projectRoute?.[1];
  const projectSessionId = projectRoute?.[2];
  const isProjectSession = !!projectId && !!projectSessionId;

  const { data: projectSessions } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId!),
    enabled: isProjectSession,
    staleTime: 10_000,
  });
  const projectSession = projectSessions?.find((s) => s.session_id === projectSessionId) ?? null;
  const canShare = !!projectSession && projectSession.can_manage_sharing !== false;

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId!, projectSessionId!),
    onSuccess: () => {
      successToast('Restarting session…');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => stopProjectSession(projectId!, projectSessionId!),
    onSuccess: () => {
      successToast('Session stopped');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to stop session');
    },
  });
  const canStop = !!projectSession && projectSession.status === 'running' && canShare;

  const readyChip = useReadyChip();

  return (
    <>
      <div className="relative z-50 w-full">
        {/* Hidden sidebar on desktop: drop the whole row onto the title-bar
            line (children h-[28px] → center y≈26, matching the traffic lights
            and the shell's Open-sidebar toggle), and indent the leading side
            past the lights + toggle. px values on purpose — the lights are
            OS-positioned; rem sizes drift with the root font. Both groups stay
            in flow so justify-between keeps the trailing cluster on the right. */}
        <div className={cn('flex items-center justify-between p-2', sidebarHidden && 'pt-[12px]')}>
          <div
            className={cn(
              // No margin transition: this indent only changes when the
              // sidebar docks/undocks, and gliding it made the row a fourth
              // competing timeline in that toggle. Docking is one frame now,
              // so the indent snaps with the panel and the gap.
              'pointer-events-auto flex items-center gap-0.5',
              // Below md the shell floats an always-on sheet opener at this
              // row's left end (see ProjectSheelLayout) — indent past it.
              // 'max-md:ml-[34px]',
              sidebarHidden && 'h-[28px]',
              sidebarHidden && (desktopShell === 'macos' ? 'ml-[96px]' : 'ml-[32px]'),
            )}
          >
            {showSidebarToggle && (
              <Button
                type="button"
                aria-label={sidebarToggleLabel}
                variant="ghost"
                size="icon"
                onClick={toggleSidebar}
                onPointerEnter={sidebarState === 'collapsed' ? peekEnter : undefined}
                onPointerLeave={sidebarState === 'collapsed' ? peekLeave : undefined}
                className="hover:bg-sidebar-accent hover:text-sidebar-foreground shrink-0 cursor-pointer items-center justify-center rounded-md transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96]"
              >
                <PanelLeft className="cn-rtl-flip size-4" />
              </Button>
            )}

            {isProjectSession && (
              <Button type="button" variant="ghost" size="icon" className="shrink-0" asChild>
                <Link href={`/projects/${projectId}`}>
                  <HouseIcon className="size-4.5" />
                </Link>
              </Button>
            )}
            {leadingAction}
          </div>

          <div
            className={cn(
              'pointer-events-auto flex items-center gap-1.5',
              sidebarHidden && 'h-[28px]',
            )}
          >
            <DropdownMenu>
              <Hint
                side="bottom"
                label={tHardcodedUi.raw(
                  'componentsSessionSessionSiteHeader.line105JsxTextMoreActions',
                )}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={tHardcodedUi.raw(
                      'componentsSessionSessionSiteHeader.line105JsxTextMoreActions',
                    )}
                    className="text-foreground/80 hover:text-foreground cursor-pointer transition-colors active:scale-[0.96]"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>

              {/* Rename/Share (identity) and Restart/Stop (lifecycle) sit at
                  full weight — those are what a normal user reaches for.
                  Export/Summarize are transcript-level, rarely-touched, and
                  jargon-adjacent (a non-technical reader has no idea what
                  "compacting" a session does), so they're visually
                  subordinate (muted text/icon) and pushed down next to
                  Delete. Delete stays the one destructive item and stays
                  last. The conditionals are arranged so a separator can
                  never lead, trail, or double up: within `isProjectSession`
                  the first two groups always have at least Rename and
                  Restart, and the transcript group is unconditional. */}
              <DropdownMenuContent align="end" className="w-56">
                {isProjectSession && (
                  <>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => setRenameOpen(true)}
                    >
                      <PencilSimpleIcon />
                      {tI18nHardcoded.raw(
                        'autoFeaturesSessionHeaderSessionSiteHeaderJsxTextRename41731a53',
                      )}
                    </DropdownMenuItem>
                    {canShare && (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => setShareOpen(true)}
                      >
                        <Share />
                        {tI18nHardcoded.raw(
                          'autoFeaturesSessionHeaderSessionSiteHeaderJsxTextShared7d34d4f',
                        )}
                      </DropdownMenuItem>
                    )}

                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                      className="cursor-pointer"
                      disabled={restartMutation.isPending}
                      onClick={() => restartMutation.mutate()}
                    >
                      {restartMutation.isPending ? <Loading /> : <RotateCcw />}
                      Restart
                    </DropdownMenuItem>
                    {canStop && (
                      <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={stopMutation.isPending}
                        onClick={() => stopMutation.mutate()}
                      >
                        {stopMutation.isPending ? <Loading /> : <Square />}
                        Stop
                      </DropdownMenuItem>
                    )}

                    <DropdownMenuSeparator />
                  </>
                )}

                <DropdownMenuItem
                  className="text-muted-foreground hover:text-foreground/90 cursor-pointer [&_svg]:opacity-70"
                  onClick={() => setExportOpen(true)}
                >
                  <FileDown />
                  Export conversation
                </DropdownMenuItem>

                <DropdownMenuItem
                  className="text-muted-foreground hover:text-foreground/90 cursor-pointer [&_svg]:opacity-70"
                  onClick={() => setCompactOpen(true)}
                >
                  <Layers />
                  Summarize conversation
                </DropdownMenuItem>

                {isProjectSession && (
                  <>
                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => setDeleteOpen(true)}
                      variant="destructive"
                    >
                      <TrashSolid weight="fill" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Resting header, non-technical default: identity (left, not
                ours) + these two indicators (self-hide via `return null`
                until there's something to see) + the panel toggle. Every
                icon-only control below carries a Hint label — nothing here
                is legible from the icon alone. */}
            <SessionChangesIndicator sessionId={sessionId} />

            <SessionPendingApprovalsIndicator sessionId={sessionId} />

            {/* Terminal / Browser / Files (grows to 4-5). Desktop (lg+):
                individual icon buttons for one-click access. Below lg: they
                collapse into a single dropdown so the header stays compact.
                Both fire the same openSessionQuickView(view, 'header') — one
                DEV_TOOLS list drives both, so a fourth/fifth tool is a
                one-line add. */}
            <div className="hidden items-center gap-1.5 lg:flex">
              {DEV_TOOLS.map(({ view, label, Icon }) => (
                <Hint key={view} side="bottom" sideOffset={4} delayDuration={300} label={label}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={label}
                    onClick={() => openSessionQuickView(view, 'header')}
                    className="text-foreground/80 hover:text-foreground cursor-pointer transition-colors active:scale-[0.96]"
                  >
                    <Icon className="h-4 w-4" />
                  </Button>
                </Hint>
              ))}
            </div>

            <DropdownMenu>
              <Hint side="bottom" sideOffset={4} delayDuration={300} label="Developer tools">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Developer tools"
                    className="text-foreground/80 hover:text-foreground cursor-pointer transition-colors active:scale-[0.96] lg:hidden"
                  >
                    <Code2 className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>

              <DropdownMenuContent align="end" className="w-44">
                {DEV_TOOLS.map(({ view, label, Icon }) => (
                  <DropdownMenuItem
                    key={view}
                    className="cursor-pointer"
                    onClick={() => openSessionQuickView(view, 'header')}
                  >
                    <Icon />
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Hint
              side="bottom"
              sideOffset={4}
              delayDuration={300}
              label={
                <span className="flex items-center gap-1.5">
                  {isSidePanelOpen ? 'Close' : 'Open'} panel
                  <KbdGroup>
                    <Kbd className="font-mono">
                      {tHardcodedUi.raw('componentsSessionSessionSiteHeader.line185JsxTextI')}
                    </Kbd>
                  </KbdGroup>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (!isSidePanelOpen) track('panel_opened', { source: 'toggle' });
                  onToggleSidePanel();
                }}
                className={cn('text-foreground cursor-pointer transition-colors')}
              >
                <span className="relative inline-flex">
                  <PanelRight className="h-4 w-4" mirrored />
                  {readyChip?.sessionId === sessionId && !isSidePanelOpen && (
                    <span
                      className="bg-kortix-green ring-background absolute -top-1 -right-1 size-2 rounded-full ring-2"
                      aria-hidden
                    />
                  )}
                </span>
              </Button>
            </Hint>
          </div>
        </div>
      </div>

      <ExportTranscriptModal sessionId={sessionId} open={exportOpen} onOpenChange={setExportOpen} />
      <CompactModal sessionId={sessionId} open={compactOpen} onOpenChange={setCompactOpen} />

      {isProjectSession && (
        <>
          <ShareSessionModal
            projectId={projectId!}
            session={projectSession}
            open={shareOpen}
            onOpenChange={setShareOpen}
            onSaved={() =>
              queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] })
            }
          />
          <RenameSessionModal
            projectId={projectId!}
            sessionId={projectSessionId!}
            currentName={projectSession ? sessionDisplayLabel(projectSession) : ''}
            open={renameOpen}
            onOpenChange={setRenameOpen}
          />
          <SessionDeleteModal
            projectId={projectId!}
            sessionId={projectSessionId!}
            sessionLabel={sessionTitle}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onDeleted={() => router.push(`/projects/${projectId}`)}
          />
        </>
      )}
    </>
  );
}
