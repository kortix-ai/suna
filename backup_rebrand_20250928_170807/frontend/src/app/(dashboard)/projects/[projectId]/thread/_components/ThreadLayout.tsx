import React from 'react';
import { SiteHeader } from '@/components/thread/thread-site-header';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { ToolCallSidePanel } from '@/components/thread/tool-call-side-panel';
import { BillingErrorAlert } from '@/components/billing/usage-limit-alert';
import { Project } from '@/lib/api';
import { ApiMessageType, BillingData } from '../_types';
import { ToolCallInput } from '@/components/thread/tool-call-side-panel';
import { useIsMobile } from '@/hooks/use-mobile';

interface ThreadLayoutProps {
  children: React.ReactNode;
  threadId: string;
  projectName: string;
  projectId: string;
  project: Project | null;
  sandboxId: string | null;
  isSidePanelOpen: boolean;
  onToggleSidePanel: () => void;
  onProjectRenamed?: (newName: string) => void;
  onViewFiles: (filePath?: string, filePathList?: string[]) => void;
  fileViewerOpen: boolean;
  setFileViewerOpen: (open: boolean) => void;
  fileToView: string | null;
  filePathList?: string[];
  toolCalls: ToolCallInput[];
  messages: ApiMessageType[];
  externalNavIndex?: number;
  agentStatus: 'idle' | 'running' | 'connecting' | 'error';
  currentToolIndex: number;
  onSidePanelNavigate: (index: number) => void;
  onSidePanelClose: () => void;
  renderAssistantMessage: (assistantContent?: string, toolContent?: string) => React.ReactNode;
  renderToolResult: (toolContent?: string, isSuccess?: boolean) => React.ReactNode;
  isLoading: boolean;
  showBillingAlert: boolean;
  billingData: BillingData;
  onDismissBilling: () => void;
  debugMode: boolean;
  isMobile: boolean;
  initialLoadCompleted: boolean;
  agentName?: string;
  disableInitialAnimation?: boolean;
  compact?: boolean;
}

export function ThreadLayout({
  children,
  threadId,
  projectName,
  projectId,
  project,
  sandboxId,
  isSidePanelOpen,
  onToggleSidePanel,
  onProjectRenamed,
  onViewFiles,
  fileViewerOpen,
  setFileViewerOpen,
  fileToView,
  filePathList,
  toolCalls,
  messages,
  externalNavIndex,
  agentStatus,
  currentToolIndex,
  onSidePanelNavigate,
  onSidePanelClose,
  renderAssistantMessage,
  renderToolResult,
  isLoading,
  showBillingAlert,
  billingData,
  onDismissBilling,
  debugMode,
  isMobile,
  initialLoadCompleted,
  agentName,
  disableInitialAnimation = false,
  compact = false
}: ThreadLayoutProps) {
  const isActuallyMobile = useIsMobile();
  
  // Compact mode for embedded use
  if (compact) {
    return (
      <>
        <div className="relative h-full">
          {debugMode && (
            <div className="absolute top-4 right-4 bg-amber-500 text-black text-xs px-2 py-1 rounded-md shadow-md z-50">
              Debug Mode
            </div>
          )}

          {/* Main content - always full width */}
          <div className="flex flex-col h-full overflow-hidden">
            {children}
          </div>

          {/* Tool Call Side Panel - Full replacement overlay for compact */}
          {isSidePanelOpen && initialLoadCompleted && (
            <div className="absolute inset-0 bg-background z-40">
              <ToolCallSidePanel
                isOpen={true}
                onClose={onSidePanelClose}
                toolCalls={toolCalls}
                messages={messages}
                externalNavigateToIndex={externalNavIndex}
                agentStatus={agentStatus}
                currentIndex={currentToolIndex}
                onNavigate={onSidePanelNavigate}
                project={project || undefined}
                renderAssistantMessage={renderAssistantMessage}
                renderToolResult={renderToolResult}
                isLoading={!initialLoadCompleted || isLoading}
                onFileClick={onViewFiles}
                agentName={agentName}
                disableInitialAnimation={disableInitialAnimation}
                compact={true}
              />
            </div>
          )}

          {/* File Viewer Modal */}
          {sandboxId && (
            <FileViewerModal
              open={fileViewerOpen}
              onOpenChange={setFileViewerOpen}
              sandboxId={sandboxId}
              initialFilePath={fileToView}
              project={project || undefined}
              filePathList={filePathList}
            />
          )}

          <BillingErrorAlert
            message={billingData.message}
            currentUsage={billingData.currentUsage}
            limit={billingData.limit}
            accountId={billingData.accountId}
            onDismiss={onDismissBilling}
            isOpen={showBillingAlert}
          />
        </div>
      </>
    );
  }

  // Full layout mode
  return (
    <div className="flex h-screen">
      {debugMode && (
        <div className="fixed top-16 right-4 bg-amber-500 text-black text-xs px-2 py-1 rounded-md shadow-md z-50">
          Debug Mode
        </div>
      )}

      <div
        className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${(!initialLoadCompleted || (isSidePanelOpen && !isActuallyMobile))
          ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]'
          : ''
          }`}
      >
        <SiteHeader
          threadId={threadId}
          projectName={projectName}
          projectId={projectId}
          onViewFiles={onViewFiles}
          onToggleSidePanel={onToggleSidePanel}
          onProjectRenamed={onProjectRenamed}
          isMobileView={isMobile}
          debugMode={debugMode}
        />

        {children}
      </div>

      <ToolCallSidePanel
        isOpen={isSidePanelOpen && initialLoadCompleted}
        onClose={onSidePanelClose}
        toolCalls={toolCalls}
        messages={messages}
        externalNavigateToIndex={externalNavIndex}
        agentStatus={agentStatus}
        currentIndex={currentToolIndex}
        onNavigate={onSidePanelNavigate}
        project={project || undefined}
        renderAssistantMessage={renderAssistantMessage}
        renderToolResult={renderToolResult}
        isLoading={!initialLoadCompleted || isLoading}
        onFileClick={onViewFiles}
        agentName={agentName}
        disableInitialAnimation={disableInitialAnimation}
      />

      {sandboxId && (
        <FileViewerModal
          open={fileViewerOpen}
          onOpenChange={setFileViewerOpen}
          sandboxId={sandboxId}
          initialFilePath={fileToView}
          project={project || undefined}
          filePathList={filePathList}
        />
      )}

      <BillingErrorAlert
        message={billingData.message}
        currentUsage={billingData.currentUsage}
        limit={billingData.limit}
        accountId={billingData.accountId}
        onDismiss={onDismissBilling}
        isOpen={showBillingAlert}
      />
    </div>
  );
} 