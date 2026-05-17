'use client';

import { useState } from 'react';
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
  PanelRightClose,
  PanelRightOpen,
  FileDown,
  Globe,
  MoreHorizontal,
  GitCompareArrows,
  Layers,
  CircleAlert,
} from 'lucide-react';
import { ExportTranscriptDialog } from '@/components/session/export-transcript-dialog';
import { DiffDialog } from '@/components/session/diff-dialog';
import { CompactDialog } from '@/components/session/compact-dialog';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';


import { DiagnosticsDialog } from '@/components/session/diagnostics-panel';
// Worktree indicator — disabled for now
// import { useOpenCodeSession, useOpenCodeCurrentProject } from '@/hooks/opencode/use-opencode-sessions';

interface SessionSiteHeaderProps {
  sessionId: string;
  sessionTitle: string;
  onToggleSidePanel: () => void;
  isSidePanelOpen?: boolean;
  isMobileView?: boolean;
  canOpenSidePanel?: boolean;
  /** Optional element rendered at the leading (left) edge of the header */
  leadingAction?: React.ReactNode;
}

export function SessionSiteHeader({
  sessionId,
  sessionTitle,
  onToggleSidePanel,
  isSidePanelOpen = false,
  isMobileView,
  canOpenSidePanel = true,
  leadingAction,
}: SessionSiteHeaderProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  // Direct shortcut: open the side panel straight into the Browser view.
  // Mirrors the kebab → panel toggle, but skips the "Actions" step.
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
  const setPanelView = useSessionBrowserStore((s) => s.setView);
  const handleOpenBrowser = () => {
    setPanelView(sessionId, 'browser');
    setIsSidePanelOpen(true);
  };

  // Worktree detection — disabled for now
  const worktreeInfo = null;

  return (
    <>
      {/* Floating actions in top-right corner */}
      <div className="absolute top-0 right-0 left-0 z-20 pointer-events-none">
        <div className="flex items-center justify-between px-3 sm:px-4 pt-2">
          {/* Left: leading action */}
          <div className="flex items-center gap-1 pointer-events-auto">
            {leadingAction}
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-0.5 pointer-events-auto">
            <TooltipProvider delayDuration={300}>
              {/* Worktree indicator — disabled for now */}

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
                    <p>More actions</p>
                  </TooltipContent>
                </Tooltip>

                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={() => setDiagnosticsOpen(true)}>
                    <CircleAlert className="mr-2 h-4 w-4" />
                    Diagnostics
                  </DropdownMenuItem>

                  {/* View Changes */}
                  <DropdownMenuItem onClick={() => setDiffOpen(true)}>
                    <GitCompareArrows className="mr-2 h-4 w-4" />
                    View changes
                  </DropdownMenuItem>

                  {/* Export transcript */}
                  <DropdownMenuItem onClick={() => setExportOpen(true)}>
                    <FileDown className="mr-2 h-4 w-4" />
                    Export transcript
                  </DropdownMenuItem>

                  {/* Compact session */}
                  <DropdownMenuItem onClick={() => setCompactOpen(true)}>
                    <Layers className="mr-2 h-4 w-4" />
                    Compact session
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Share button — temporarily hidden until share architecture is resolved */}
              {/* <SharePopover sessionId={sessionId}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2.5 cursor-pointer gap-1.5"
                >
                  <Upload className="h-4 w-4" />
                  <span className="hidden sm:inline text-sm">Share</span>
                </Button>
              </SharePopover> */}

              {/* Browser shortcut — pops the side panel straight to the
                  internal browser, skipping the Actions step. */}
              {canOpenSidePanel && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleOpenBrowser}
                      className="h-8 w-8 cursor-pointer text-muted-foreground hover:text-foreground"
                    >
                      <Globe className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    <p>Open browser</p>
                  </TooltipContent>
                </Tooltip>
              )}

              {/* Panel toggle */}
              {canOpenSidePanel && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onToggleSidePanel}
                      className="h-8 w-8 cursor-pointer text-muted-foreground hover:text-foreground"
                    >
                      {isSidePanelOpen ? (
                        <PanelRightClose className="h-4 w-4" />
                      ) : (
                        <PanelRightOpen className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    <p>{isSidePanelOpen ? 'Close' : 'Open'} panel</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <ExportTranscriptDialog
        sessionId={sessionId}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />
      <DiffDialog
        sessionId={sessionId}
        open={diffOpen}
        onOpenChange={setDiffOpen}
      />
      <CompactDialog
        sessionId={sessionId}
        open={compactOpen}
        onOpenChange={setCompactOpen}
      />
      <DiagnosticsDialog
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
      />
    </>
  );
}
