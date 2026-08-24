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
import Loading from '@/components/ui/loading';
import { useSidebar } from '@/components/ui/sidebar';
import { errorToast, successToast } from '@/components/ui/toast';
import { CompactModal } from '@/features/session/header/compact-modal';
import { ExportTranscriptModal } from '@/features/session/header/export-transcript-modal';
import { SessionChangesIndicator } from '@/features/session/header/session-changes-indicator';
import {
  SessionConfigIndicator,
  SessionConfigReloadConfirm,
} from '@/features/session/header/session-config-indicator';
import { SessionPendingApprovalsIndicator } from '@/features/session/header/session-pending-approvals-indicator';
import { openSessionQuickView } from '@/features/session/open-session-quick-view';
import {
  sidebarOpenerLabel,
  useDesktopShell,
  useShowPageSidebarOpener,
} from '@/features/workspace/project-layout/sidebar-opener';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/project-sidebar/modal/share-session-modal';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { useReloadSessionConfig } from '@/hooks/projects/use-session-config-freshness';
import { cn } from '@/lib/utils';
import {
  type QuickView,
  useIsActionPanelOpen,
  useReadyChip,
  useToggleActionPanel,
} from '@/stores/kortix-computer-store';
import { listProjectSessions, restartProjectSession, stopProjectSession } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  ArrowsClockwiseIcon,
  CaretDoubleLeftIcon,
  CaretDownIcon,
  CodeSimpleIcon as Code2,
  FileArrowDownIcon as FileDown,
  FolderSimpleIcon,
  GlobeSimpleIcon,
  StackIcon as Layers,
  SidebarSimpleIcon as PanelLeft,
  PencilSimpleIcon,
  ArrowCounterClockwiseIcon as RotateCcw,
  ShareIcon as Share,
  SquareIcon as Square,
  TerminalIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  { view: 'terminal', label: 'Terminal', Icon: TerminalIcon },
  { view: 'browser', label: 'Browser', Icon: GlobeSimpleIcon },
  { view: 'files', label: 'Files', Icon: FolderSimpleIcon },
];

interface SessionSiteHeaderProps {
  sessionId: string;
  sessionTitle: string;
  isMobileView?: boolean;
  leadingAction?: React.ReactNode;
}

export function SessionSiteHeader({
  sessionId,
  sessionTitle,
  isMobileView,
  leadingAction,
}: SessionSiteHeaderProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  // Desktop shell with the sidebar hidden (offcanvas): this header reaches the
  // window's top-left corner, which the OS owns — the macOS traffic lights and
  // the shell's one "Open sidebar" toggle both live in that band. The row
  // indents past them and drops onto their centre line; `.kx-titlebar-row`
  // carries both offsets so no window px are hard-coded here.
  const {
    state: sidebarState,
    toggleSidebar,
    peek,
    peekEnter,
    peekLeave,
    isMobile: isMobileViewport,
  } = useSidebar();
  const desktopShell = useDesktopShell();
  const sidebarHidden = desktopShell !== null && sidebarState === 'collapsed';
  const sidebarToggleLabel = sidebarOpenerLabel({ state: sidebarState, peek });
  // Shared gate — see sidebar-opener.ts.
  const showSidebarToggle = useShowPageSidebarOpener();

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
    queryKey: qk.project.sessions(projectId ?? ''),
    queryFn: () => listProjectSessions(projectId!),
    enabled: isProjectSession,
    ...contract('inventory'),
  });
  const projectSession = projectSessions?.find((s) => s.session_id === projectSessionId) ?? null;
  // Two verdicts, deliberately not one flag. `can_manage_sharing` is the
  // owner's right to change who can open the session; `can_manage_lifecycle`
  // is the manager-tier right to stop/restart/reload it. Reading the first for
  // a lifecycle control would hide Stop and Reload from every project manager
  // who did not create the session.
  const canManageSharing = !!projectSession && projectSession.can_manage_sharing !== false;
  const canManageLifecycle = !!projectSession && projectSession.can_manage_lifecycle !== false;

  /**
   * The name shown in the header, matched to the sidebar row.
   *
   * `sessionTitle` is OPENCODE's `session.title` — the summary it writes for
   * itself ("Greeting"). The sidebar shows Kortix's session name ("Just A
   * Simple Hey"), and a rename only ever touches that one, so the two drifted
   * apart the moment opencode auto-titled: the same session read as two
   * different things depending on where you looked.
   *
   * Uses the SIDEBAR's helper, not `sessionDisplayLabel`, so the two strings
   * cannot diverge on the fallback either — they differ for an untitled session
   * ("New session" vs a branch/id slice).
   *
   * Falls back to the prop when there is no project session: the share viewer
   * and the instant shell render this header without one.
   */
  const headerTitle = projectSession ? getSessionDisplayTitle(projectSession) : sessionTitle;

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId!, projectSessionId!),
    onSuccess: () => {
      successToast('Restarting session…');
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId ?? '') });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => stopProjectSession(projectId!, projectSessionId!),
    onSuccess: () => {
      successToast('Session stopped');
      queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId ?? '') });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to stop session');
    },
  });
  const canStop = !!projectSession && projectSession.status === 'running' && canManageLifecycle;

  // Hoisted so the chip and the ⋯ item share one pending state and one confirm
  // dialog. `canManageLifecycle` is the client mirror of the reload route's own
  // gate (session owner or project manager) — the IAM leaf both member and
  // editor hold would still 403 here.
  const reloadConfig = useReloadSessionConfig(projectId!, projectSessionId!);

  // Mobile-only action-panel toggle — see its render site below.
  const isActionPanelOpen = useIsActionPanelOpen();
  const toggleActionPanel = useToggleActionPanel();
  const readyChip = useReadyChip();

  const sessionActionItems = (
    <>
      {isProjectSession && (
        <>
          <DropdownMenuItem className="cursor-pointer" onClick={() => setRenameOpen(true)}>
            <PencilSimpleIcon />
            {tI18nHardcoded.raw('autoFeaturesSessionHeaderSessionSiteHeaderJsxTextRename41731a53')}
          </DropdownMenuItem>
          {/* Shown to everyone in the session: the owner changes access here,
              everyone else reads who has it. */}
          <DropdownMenuItem className="cursor-pointer" onClick={() => setShareOpen(true)}>
            <Share />
            {canManageSharing
              ? tI18nHardcoded.raw('autoFeaturesSessionHeaderSessionSiteHeaderJsxTextShared7d34d4f')
              : 'Who has access'}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            className="cursor-pointer"
            disabled={restartMutation.isPending}
            onClick={() => restartMutation.mutate()}
          >
            {restartMutation.isPending ? <Loading /> : <RotateCcw />}
            Restart
          </DropdownMenuItem>
          {canManageLifecycle && (
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={reloadConfig.isPending}
              onClick={() => reloadConfig.reload()}
            >
              {reloadConfig.isPending ? <Loading /> : <ArrowsClockwiseIcon />}
              Reload config
            </DropdownMenuItem>
          )}
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

          <DropdownMenuItem className="cursor-pointer" onClick={() => setDeleteOpen(true)}>
            <TrashIcon />
            Delete
          </DropdownMenuItem>
        </>
      )}
    </>
  );

  return (
    <>
      <div className="relative z-50 w-full">
        {/* Desktop shell: this row IS the title-bar band, so it takes the
            band's own offsets rather than picking its own. `.kx-titlebar-row`
            indents the leading side past the OS controls plus the shell's
            toggle (macOS: lights + toggle; Win/Linux: toggle) and reserves the
            right edge for the Win/Linux min/max/close cluster — which this row
            previously ran straight underneath. `--kx-titlebar-control-top`
            plus the 28px children put the row on the controls' centre line;
            the old literals (pt-12 / h-28 → y=26 against lights at y=30) were
            copied by hand and had drifted 4px out.

            Both groups stay in flow so justify-between keeps the trailing
            cluster on the right. No margin transition: the indent only changes
            when the sidebar docks/undocks, and gliding it made the row a
            fourth competing timeline in that toggle — it snaps with the panel
            instead. */}
        <div
          className={cn(
            'flex items-center justify-between p-2 px-3.5 pt-2 pr-4',
            // Unconditional on the shell. The LEFT indent depends on the
            // sidebar (expanded, it covers the macOS lights itself) and is
            // gated by the data attribute — but the RIGHT one does not: this
            // column's right edge is the window's right edge whatever the
            // sidebar does, so on Win/Linux the trailing dev-tools cluster
            // sits under min/max/close either way.
            desktopShell !== null && 'kx-titlebar-row',
            sidebarHidden && 'pt-[var(--kx-titlebar-control-top)]',
          )}
          data-sidebar-collapsed={sidebarHidden || undefined}
        >
          <div
            className={cn(
              'pointer-events-auto flex min-w-0 items-center gap-0.5',
              sidebarHidden && 'h-[var(--kx-titlebar-control-size)]',
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

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-foreground/80 hover:text-foreground data-[state=open]:bg-card group h-auto min-w-0 shrink justify-start gap-3 rounded-md px-2.5 py-1 transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.96] has-[>svg]:px-2.5"
                >
                  <span className="min-w-0 truncate">{headerTitle}</span>
                  <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]:rotate-180" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {sessionActionItems}
              </DropdownMenuContent>
            </DropdownMenu>

            {leadingAction}
          </div>

          <div
            className={cn(
              'pointer-events-auto flex items-center gap-1.5',
              sidebarHidden && 'h-[var(--kx-titlebar-control-size)]',
            )}
          >
            <SessionChangesIndicator sessionId={sessionId} />

            <SessionPendingApprovalsIndicator sessionId={sessionId} />

            {isProjectSession && (
              <SessionConfigIndicator
                projectId={projectId!}
                sessionId={projectSessionId!}
                chatSessionId={sessionId}
                baseRef={projectSession?.base_ref}
                reload={reloadConfig.reload}
                isPending={reloadConfig.isPending}
                phase={reloadConfig.phase}
                canReload={canManageLifecycle}
              />
            )}

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

            {/* The DETAIL panel's toggle used to sit here and is gone on
                purpose: that panel opens with content (a terminal, a browser, a
                file) and closes with its own X or Escape, so a control that
                opened it empty had nothing to show.

                This one is the ACTION panel's, and mobile-only. On desktop the
                cards are a column beside the chat with their own chevron; below
                768px there is no room for a column, so the cards live in the
                bottom drawer and need a way in from here. Gated on
                `useIsMobile()` — the same 768px breakpoint the column and the
                drawer both use, so exactly one control exists at any width and
                the two can never both show. */}
            {isMobileViewport && (
              <Hint side="bottom" sideOffset={4} delayDuration={300} label="Show panel">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Show panel"
                  aria-expanded={isActionPanelOpen}
                  onClick={toggleActionPanel}
                  className="text-foreground/80 hover:text-foreground cursor-pointer transition-colors active:scale-[0.96]"
                >
                  <span className="relative inline-flex">
                    <CaretDoubleLeftIcon className="size-4" />
                    {/* Badge, not a tag: attached to this control and purely
                        informational. `setIsActionPanelOpen` clears it. */}
                    {readyChip?.sessionId === sessionId && !isActionPanelOpen && (
                      <span
                        className="bg-kortix-green ring-background absolute -top-1 -right-1 size-2 rounded-full ring-2"
                        aria-hidden
                      />
                    )}
                  </span>
                </Button>
              </Hint>
            )}
          </div>
        </div>
      </div>

      <ExportTranscriptModal
        sessionId={sessionId}
        kortixSessionScope={isProjectSession ? `${projectId}/${projectSessionId}` : undefined}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
      <CompactModal sessionId={sessionId} open={compactOpen} onOpenChange={setCompactOpen} />

      {isProjectSession && (
        <>
          {/* Mounted here, not inside the chip: a successful reload can make
              the chip unmount, and a dialog that disappears mid-question is
              worse than no dialog. */}
          <SessionConfigReloadConfirm
            busyReason={reloadConfig.busyReason}
            isPending={reloadConfig.isPending}
            onConfirm={() => reloadConfig.reload({ force: true })}
            onDismiss={reloadConfig.clearBusy}
          />
          <ShareSessionModal
            projectId={projectId!}
            session={projectSession}
            open={shareOpen}
            onOpenChange={setShareOpen}
            onSaved={() =>
              queryClient.invalidateQueries({
                queryKey: qk.project.sessionsScope(projectId ?? ''),
              })
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
            sessionLabel={headerTitle}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onDeleted={() => router.push(`/projects/${projectId}`)}
          />
        </>
      )}
    </>
  );
}
