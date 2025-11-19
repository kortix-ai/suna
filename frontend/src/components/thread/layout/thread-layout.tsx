import React, { useState, useEffect, useRef } from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { SiteHeader } from '@/components/thread/thread-site-header';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { ToolCallSidePanel } from '@/components/thread/tool-call-side-panel';
import { Project } from '@/lib/api/projects';
import { ApiMessageType } from '@/components/thread/types';
import { ToolCallInput } from '@/components/thread/tool-call-side-panel';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';

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
  isMobile: boolean;
  initialLoadCompleted: boolean;
  agentName?: string;
  disableInitialAnimation?: boolean;
  compact?: boolean;
  variant?: 'default' | 'shared';
  chatInput?: React.ReactNode;
  leftSidebarState?: 'collapsed' | 'expanded';
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
  isMobile,
  initialLoadCompleted,
  agentName,
  disableInitialAnimation = false,
  compact = false,
  variant = 'default',
  chatInput,
  leftSidebarState = 'collapsed',
}: ThreadLayoutProps) {
  const isActuallyMobile = useIsMobile();
  
  // Track when panel should be visible
  const shouldShowPanel = isSidePanelOpen && initialLoadCompleted;
  
  // Refs for panel APIs to control sizes programmatically
  const mainPanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const sidePanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  
  // Update sizes when panel visibility changes with smooth animation
  useEffect(() => {
    if (shouldShowPanel) {
      // Open panel smoothly
      requestAnimationFrame(() => {
        sidePanelRef.current?.resize(40);
        mainPanelRef.current?.resize(60);
      });
    } else {
      // Close panel - resize smoothly, content disappears immediately
      const timeout = setTimeout(() => {
        sidePanelRef.current?.resize(0);
        mainPanelRef.current?.resize(100);
      }, 0);
      return () => clearTimeout(timeout);
    }
  }, [shouldShowPanel]);

  // Compact mode for embedded use
  if (compact) {
    return (
      <>
        <div className="relative h-full">
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
        </div>
      </>
    );
  }

  // Full layout mode
  // Use ResizablePanelGroup for desktop, regular flex for mobile
  if (isActuallyMobile) {
    return (
      <div className="flex h-screen">
        <div className="flex flex-col flex-1 overflow-hidden relative">
          <SiteHeader
            threadId={threadId}
            projectName={projectName}
            projectId={projectId}
            onViewFiles={onViewFiles}
            onToggleSidePanel={onToggleSidePanel}
            onProjectRenamed={onProjectRenamed}
            isMobileView={isMobile}
            variant={variant}
          />

          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
            {children}
          </div>

          {/* ChatInput - positioned at bottom for mobile */}
          {chatInput && (
            <div className="flex-shrink-0 relative z-10 bg-gradient-to-b from-background via-background/90 to-transparent px-4">
              {chatInput}
            </div>
          )}
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
      </div>
    );
  }

  // Desktop layout with resizable panels
  return (
    <div className="flex h-screen">
      <ResizablePanelGroup 
        direction="horizontal" 
        className="h-screen"
        style={{ transition: 'none' }}
      >
        {/* Main content panel */}
        <ResizablePanel
          ref={mainPanelRef}
          defaultSize={shouldShowPanel ? 60 : 100}
          minSize={shouldShowPanel ? 30 : 100}
          maxSize={shouldShowPanel ? 95 : 100}
          className="flex flex-col overflow-hidden relative bg-transparent"
        >
          <SiteHeader
            threadId={threadId}
            projectName={projectName}
            projectId={projectId}
            onViewFiles={onViewFiles}
            onToggleSidePanel={onToggleSidePanel}
            onProjectRenamed={onProjectRenamed}
            isMobileView={isMobile}
            variant={variant}
          />

          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
            {children}
          </div>

          {/* ChatInput - positioned at bottom of main content panel */}
          {chatInput && (
            <div className="flex-shrink-0 relative z-10 bg-gradient-to-b from-background via-background/90 to-transparent px-4">
              {chatInput}
            </div>
          )}
        </ResizablePanel>

        {/* Resizable handle - always render */}
        <ResizableHandle 
          withHandle={true}
          className="z-20 w-0"
        />
        
        {/* Side panel - always render but control size */}
        <ResizablePanel
          ref={sidePanelRef}
          defaultSize={shouldShowPanel ? 40 : 0}
          minSize={shouldShowPanel ? 20 : 0}
          maxSize={shouldShowPanel ? 70 : 0}
          collapsible={true}
          className={cn(
            "relative bg-transparent",
            // Match ChatInput horizontal spacing: px-4
            shouldShowPanel ? "pr-4 pb-5 pt-4"  : "px-0",
            !shouldShowPanel ? "hidden" : ""
          )}
        >
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
        </ResizablePanel>
      </ResizablePanelGroup>

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
    </div>
  );
}

