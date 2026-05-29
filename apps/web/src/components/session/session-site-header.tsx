'use client';

import { useTranslations } from 'next-intl';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  PanelRight,
  FileDown,
  MoreHorizontal,
  Layers,
  Loader2,
  RotateCcw,
  Share2,
  Trash2,
} from 'lucide-react';
import { ExportTranscriptDialog } from '@/components/session/export-transcript-dialog';
import { CompactDialog } from '@/components/session/compact-dialog';
import { SessionShareDialog } from '@/components/projects/session-share-dialog';
import {
  deleteProjectSession,
  listProjectSessions,
  restartProjectSession,
} from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface SessionSiteHeaderProps {
  sessionId: string;
  sessionTitle: string;
  onToggleSidePanel: () => void;
  isSidePanelOpen?: boolean;
  isMobileView?: boolean;
  /** Optional element rendered at the leading (left) edge of the header */
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [exportOpen, setExportOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
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
  const projectSession =
    projectSessions?.find((s) => s.session_id === projectSessionId) ?? null;
  const canShare = !!projectSession && projectSession.can_manage_sharing !== false;

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId!, projectSessionId!),
    onSuccess: () => {
      toast.success('Restarting session…');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteProjectSession(projectId!, projectSessionId!),
    onSuccess: () => {
      toast.success('Session deleted');
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      router.push(`/projects/${projectId}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete session');
    },
  });

  return (
    <>
      {/* Floating actions overlaying the top edge of the session */}
      <div className="absolute top-0 right-0 left-0 z-20 pointer-events-none">
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center justify-between px-3 sm:px-4 pt-2">
            {/* Left: leading action + overflow menu */}
            <div className="flex items-center gap-0.5 pointer-events-auto">
              {leadingAction}

              {/* More actions dropdown */}
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 cursor-pointer text-muted-foreground hover:text-foreground"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    <p>{tHardcodedUi.raw('componentsSessionSessionSiteHeader.line105JsxTextMoreActions')}</p>
                  </TooltipContent>
                </Tooltip>

                <DropdownMenuContent align="start" className="w-52">
                  {/* Lifecycle actions — parity with the session list */}
                  {isProjectSession && (
                    <>
                      {canShare && (
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onClick={() => setShareOpen(true)}
                        >
                          <Share2 className="h-4 w-4" />
                          Share…
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={restartMutation.isPending}
                        onClick={() => restartMutation.mutate()}
                      >
                        {restartMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                        Restart
                      </DropdownMenuItem>
                    </>
                  )}

                  {/* Export transcript */}
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={() => setExportOpen(true)}
                  >
                    <FileDown className="h-4 w-4" />{tHardcodedUi.raw('componentsSessionSessionSiteHeader.line124JsxTextExportTranscript')}</DropdownMenuItem>

                  {/* Compact session */}
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={() => setCompactOpen(true)}
                  >
                    <Layers className="h-4 w-4" />{tHardcodedUi.raw('componentsSessionSessionSiteHeader.line130JsxTextCompactSession')}</DropdownMenuItem>

                  {/* Delete */}
                  {isProjectSession && (
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Right: panel toggle — always available, even on an empty
                session with no tool calls, so the side panel (Actions /
                Browser / Files / Terminal) is always one click away. */}
            <div className="flex items-center pointer-events-auto">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onToggleSidePanel}
                    className={cn(
                      'h-8 w-8 cursor-pointer transition-colors',
                      isSidePanelOpen
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <PanelRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  <p className="flex items-center gap-1.5">
                    {isSidePanelOpen ? 'Close' : 'Open'} panel
                    <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {tHardcodedUi.raw('componentsSessionSessionSiteHeader.line185JsxTextI')}</kbd>
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </TooltipProvider>
      </div>

      {/* Dialogs */}
      <ExportTranscriptDialog
        sessionId={sessionId}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
      <CompactDialog
        sessionId={sessionId}
        open={compactOpen}
        onOpenChange={setCompactOpen}
      />
      {isProjectSession && (
        <>
          <SessionShareDialog
            projectId={projectId!}
            session={projectSession}
            open={shareOpen}
            onOpenChange={setShareOpen}
            onSaved={() =>
              queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] })
            }
          />
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete session?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently destroy the branch and sandbox for{' '}
                  <span className="font-medium text-foreground">{sessionTitle}</span>. This
                  action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    deleteMutation.mutate();
                    setDeleteOpen(false);
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </>
  );
}
