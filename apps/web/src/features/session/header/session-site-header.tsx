'use client';

import { useTranslations } from 'next-intl';

import { sessionDisplayLabel } from '@/components/projects/session-label';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import Loading from '@/components/ui/loading';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { errorToast, successToast } from '@/components/ui/toast';
import { CompactModal } from '@/features/session/header/compact-modal';
import { ExportTranscriptModal } from '@/features/session/header/export-transcript-modal';
import { SessionChangesIndicator } from '@/features/session/header/session-changes-indicator';
import { SessionPendingApprovalsIndicator } from '@/features/session/header/session-pending-approvals-indicator';
import { RenameSessionModal } from '@/features/workspace/project-sidebar/modal/rename-session-modal';
import { SessionDeleteModal } from '@/features/workspace/project-sidebar/modal/session-delete-modal';
import { ShareSessionModal } from '@/features/workspace/project-sidebar/modal/share-session-modal';
import { desktopPlatform, isDesktop } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import {
  listProjectSessions,
  restartProjectSession,
  stopProjectSession,
} from '@kortix/sdk/projects-client';
import { HomeSolid, Pencil, Share, TrashSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, Layers, MoreHorizontal, PanelRight, RotateCcw, Square } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

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
  const { state: sidebarState } = useSidebar();
  const [desktopShell] = useState<'macos' | 'other' | null>(() =>
    isDesktop() ? (desktopPlatform() === 'macos' ? 'macos' : 'other') : null,
  );
  const sidebarHidden = desktopShell !== null && sidebarState === 'collapsed';

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

  return (
    <>
      <div className="z-20 w-full border-b">
        {/* Hidden sidebar on desktop: drop the whole row onto the title-bar
            line (children h-[28px] → center y≈26, matching the traffic lights
            and the shell's Open-sidebar toggle), and indent the leading side
            past the lights + toggle. px values on purpose — the lights are
            OS-positioned; rem sizes drift with the root font. Both groups stay
            in flow so justify-between keeps the trailing cluster on the right. */}
        <div
          className={cn(
            'flex items-center justify-between p-2',
            sidebarHidden && 'pt-[12px]',
          )}
        >
          <div
            className={cn(
              'pointer-events-auto flex items-center gap-0.5',
              sidebarHidden && 'h-[28px]',
              sidebarHidden && (desktopShell === 'macos' ? 'ml-[96px]' : 'ml-[32px]'),
            )}
          >
            {isProjectSession && (
              <>
                <SidebarTrigger
                  className="size-8 md:hidden"
                  aria-label={tI18nHardcoded.raw(
                    'autoFeaturesCoWorkerProjectHeaderProjectTopBarJsxAttr9a2fb75f',
                  )}
                />
                <Button type="button" variant="ghost" size="icon" className="shrink-0" asChild>
                  <Link href={`/projects/${projectId}`}>
                    <HomeSolid className="size-4.5" />
                  </Link>
                </Button>
              </>
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
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>

              <DropdownMenuContent align="end" className="w-52">
                {isProjectSession && (
                  <>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => setRenameOpen(true)}
                    >
                      <Pencil />
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
                  </>
                )}

                <DropdownMenuItem className="cursor-pointer" onClick={() => setExportOpen(true)}>
                  <FileDown />
                  {tHardcodedUi.raw(
                    'componentsSessionSessionSiteHeader.line124JsxTextExportTranscript',
                  )}
                </DropdownMenuItem>

                <DropdownMenuItem className="cursor-pointer" onClick={() => setCompactOpen(true)}>
                  <Layers />
                  {tHardcodedUi.raw(
                    'componentsSessionSessionSiteHeader.line130JsxTextCompactSession',
                  )}
                </DropdownMenuItem>

                {isProjectSession && (
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={() => setDeleteOpen(true)}
                    variant="destructive"
                  >
                    <TrashSolid />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <SessionChangesIndicator sessionId={sessionId} />

            <SessionPendingApprovalsIndicator sessionId={sessionId} />

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
                onClick={onToggleSidePanel}
                className={cn(
                  'cursor-pointer transition-colors',
                  isSidePanelOpen
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <PanelRight className="h-4 w-4" />
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
