import React from 'react';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { ToolCallSidePanel } from '@/components/thread/tool-call-side-panel';
import { SiteHeader } from '@/components/thread/thread-site-header';
import { Project } from '@/lib/api';
import { ToolCallInput } from '@/components/thread/tool-call-side-panel';
import { useIsMobile } from '@/hooks/use-mobile';
import { UnifiedMessage } from '@/components/thread/types';



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
        <SiteHeader
          projectName={projectName}
          onViewFiles={onViewFiles}
          onToggleSidePanel={onToggleSidePanel}
          isMobileView={isActuallyMobile}
          variant="shared"
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
