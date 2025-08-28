import React from 'react';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { ToolCallSidePanel } from '@/components/thread/tool-call-side-panel';
import { Button } from "@/components/ui/button";
import { FolderOpen, Monitor, Share2, Copy, Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Project } from '@/lib/api';
import { ToolCallInput } from '@/components/thread/tool-call-side-panel';
import { useIsMobile } from '@/hooks/use-mobile';
import { UnifiedMessage } from '@/components/thread/types';
import { cn } from "@/lib/utils";

interface ShareSiteHeaderProps {
  projectName: string;
  onViewFiles: () => void;
  onToggleSidePanel: () => void;
  isMobileView?: boolean;
}

function ShareSiteHeader({
  projectName,
  onViewFiles,
  onToggleSidePanel,
  isMobileView,
}: ShareSiteHeaderProps) {
  const isMobile = useIsMobile() || isMobileView;
  const [copied, setCopied] = useState(false);

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      toast.success("Share link copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy link");
    }
  };

  return (
    <header className={cn(
      "bg-background sticky top-0 flex h-14 shrink-0 items-center gap-2 z-20 w-full",
      isMobile && "px-2"
    )}>
      <div className="flex flex-1 items-center gap-2 px-3">
        <div className="text-base font-medium text-muted-foreground flex items-center gap-2">
          {projectName}
          <span className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 px-2 py-0.5 rounded-full">
            Shared
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1 pr-4">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                onClick={copyShareLink}
                className="h-9 px-3 cursor-pointer gap-2"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span>{copied ? 'Copied!' : 'Copy Link'}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side={isMobile ? "bottom" : "bottom"}>
              <p>Copy share link</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onViewFiles}
                className="h-9 w-9 cursor-pointer"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side={isMobile ? "bottom" : "bottom"}>
              <p>View Files in Task</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleSidePanel}
                className="h-9 w-9 cursor-pointer"
              >
                <Monitor className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side={isMobile ? "bottom" : "bottom"}>
              <p>Toggle Computer Preview (CMD+I)</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </header>
  );
}

interface ShareThreadLayoutProps {
  children: React.ReactNode;
  threadId: string;
  projectId: string;
  projectName: string;
  project: Project | null;
  sandboxId: string | null;
  isSidePanelOpen: boolean;
  onToggleSidePanel: () => void;
  onViewFiles: (filePath?: string, filePathList?: string[]) => void;
  fileViewerOpen: boolean;
  setFileViewerOpen: (open: boolean) => void;
  fileToView: string | null;
  toolCalls: ToolCallInput[];
  messages: UnifiedMessage[];
  externalNavIndex?: number;
  agentStatus: 'idle' | 'running' | 'connecting' | 'error';
  currentToolIndex: number;
  onSidePanelNavigate: (index: number) => void;
  onSidePanelClose: () => void;
  initialLoadCompleted: boolean;
}

export function ShareThreadLayout({
  children,
  threadId,
  projectId,
  projectName,
  project,
  sandboxId,
  isSidePanelOpen,
  onToggleSidePanel,
  onViewFiles,
  fileViewerOpen,
  setFileViewerOpen,
  fileToView,
  toolCalls,
  messages,
  externalNavIndex,
  agentStatus,
  currentToolIndex,
  onSidePanelNavigate,
  onSidePanelClose,
  initialLoadCompleted,
}: ShareThreadLayoutProps) {
  const isActuallyMobile = useIsMobile();
  
  return (
    <div className="flex h-screen">
      <div
        className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${
          isSidePanelOpen && !isActuallyMobile
            ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]'
            : ''
        }`}
      >
        <ShareSiteHeader
          projectName={projectName}
          onViewFiles={onViewFiles}
          onToggleSidePanel={onToggleSidePanel}
          isMobileView={isActuallyMobile}
        />

        {children}
      </div>

      <ToolCallSidePanel
        isOpen={isSidePanelOpen && initialLoadCompleted}
        onClose={onSidePanelClose}
        toolCalls={toolCalls}
        messages={messages as any[]}
        externalNavigateToIndex={externalNavIndex}
        agentStatus={agentStatus}
        currentIndex={currentToolIndex}
        onNavigate={onSidePanelNavigate}
        project={project || undefined}
        isLoading={false}
        onFileClick={onViewFiles}
      />

      {sandboxId && (
        <FileViewerModal
          open={fileViewerOpen}
          onOpenChange={setFileViewerOpen}
          sandboxId={sandboxId}
          initialFilePath={fileToView}
          project={project || undefined}
        />
      )}
    </div>
  );
}
