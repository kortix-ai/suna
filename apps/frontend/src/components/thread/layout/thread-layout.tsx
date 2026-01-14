import React, { useState, useEffect, useRef, memo, useMemo } from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { SiteHeader } from '@/components/thread/thread-site-header';
import { KortixComputer, ToolCallInput } from '@/components/thread/kortix-computer';
import { Project } from '@/lib/api/threads';
import { ApiMessageType } from '@/components/thread/types';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

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
  streamingTextContent?: string;
  streamingToolCall?: any;
  modeStarter?: 'presentation' | 'sheets' | 'docs' | 'canvas' | 'video' | 'research' | null;
  onModeStarterAction?: (method: 'prompt' | 'pdf' | 'link', template?: string, data?: { url?: string; file?: File }) => void;
  onModeStarterTemplate?: (templateId: string) => void;
  onModeStarterClose?: () => void;
  onStarterPrompt?: (prompt: string, placeholderInfo?: { start: number; end: number }) => void;
}

export const ThreadLayout = memo(function ThreadLayout({
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
  streamingTextContent,
  streamingToolCall,
}: ThreadLayoutProps) {
  const isActuallyMobile = useIsMobile();

  // Kortix Computer Store - for handling file open requests
  const { shouldOpenPanel, clearShouldOpenPanel, openFileInComputer, openFileBrowser } = useKortixComputerStore();

  // Track when panel should be visible
  const shouldShowPanel = isSidePanelOpen && initialLoadCompleted;

  // Extract streaming tool arguments as JSON string (what FileOperationToolView expects)
  const streamingToolArgsJson = React.useMemo(() => {
    if (!streamingToolCall) return undefined;

    try {
      const metadata = typeof streamingToolCall.metadata === 'string'
        ? JSON.parse(streamingToolCall.metadata)
        : streamingToolCall.metadata;

      const args = metadata?.tool_calls?.[0]?.arguments;

      if (!args) return undefined;

      const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
      return argsStr;
    } catch (e) {
      return undefined;
    }
  }, [streamingToolCall]);

  // Refs for panel APIs to control sizes programmatically
  const mainPanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const sidePanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);

  // Handle file click - now opens in Kortix Computer instead of modal
  const handleFileClick = React.useCallback((filePath?: string, filePathList?: string[]) => {
    if (filePath) {
      // If a specific file is provided, open it in the file viewer
      openFileInComputer(filePath, filePathList);
      // Open the side panel if it's not already open
      if (!isSidePanelOpen) {
        onToggleSidePanel();
      }
    } else {
      // If no file is provided, open the Files browser tab
      openFileBrowser();
      // Open the side panel if it's not already open
      if (!isSidePanelOpen) {
        onToggleSidePanel();
      }
    }
  }, [openFileInComputer, openFileBrowser, isSidePanelOpen, onToggleSidePanel]);

  // Listen for store's shouldOpenPanel flag to auto-open the panel
  useEffect(() => {
    if (shouldOpenPanel && !isSidePanelOpen) {
      onToggleSidePanel();
      clearShouldOpenPanel();
    } else if (shouldOpenPanel) {
      clearShouldOpenPanel();
    }
  }, [shouldOpenPanel, isSidePanelOpen, onToggleSidePanel, clearShouldOpenPanel]);

  // Get selected file path from store
  const selectedFilePath = useKortixComputerStore((state) => state.selectedFilePath);
  
  const SUITE_MODE_FILE_EXTENSIONS = [
    'kanvax', 
    'pptx', 
    'ppt', 
    'xlsx', 
    'xls', 
    'csv'
  ];

  const isSuiteMode = useMemo(() => {
    if (selectedFilePath) {
      const ext = selectedFilePath.split('.').pop()?.toLowerCase();
      if (SUITE_MODE_FILE_EXTENSIONS.includes(ext || '')) {
        return true;
      }
    }
    return false;
  }, [selectedFilePath]);

  useEffect(() => {
    if (shouldShowPanel) {
      // Auto-expand for suite mode with animation delay
      if (isSuiteMode) {
        const timer = setTimeout(() => {
          sidePanelRef.current?.resize(70);
          mainPanelRef.current?.resize(30);
        }, 100);
        return () => clearTimeout(timer);
      } else {
      sidePanelRef.current?.resize(50);
      mainPanelRef.current?.resize(50);
      }
    } else {
      sidePanelRef.current?.resize(0);
      mainPanelRef.current?.resize(100);
    }
  }, [shouldShowPanel, isSuiteMode]);

  if (compact) {
    return (
      <>
        <div className="relative h-full">
          <div className="flex flex-col h-full overflow-hidden">
            {children}
          </div>
          {isSidePanelOpen && initialLoadCompleted && (
            <div className="absolute inset-0 bg-background z-40">
              <KortixComputer
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
                onFileClick={handleFileClick}
                agentName={agentName}
                disableInitialAnimation={disableInitialAnimation}
                compact={true}
                streamingText={streamingToolArgsJson}
                sandboxId={sandboxId || undefined}
                projectId={projectId}
              />
            </div>
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
            onViewFiles={handleFileClick}
            onToggleSidePanel={onToggleSidePanel}
            isSidePanelOpen={isSidePanelOpen}
            onProjectRenamed={onProjectRenamed}
            isMobileView={isMobile}
            variant={variant}
          />

          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
            {children}
          </div>

          {/* ChatInput - positioned at bottom for mobile */}
          {chatInput && (
            <div className="flex-shrink-0 relative bg-background px-4">
              {chatInput}
            </div>
          )}
        </div>

        <KortixComputer
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
          onFileClick={handleFileClick}
          agentName={agentName}
          disableInitialAnimation={disableInitialAnimation}
          streamingText={streamingToolArgsJson}
          sandboxId={sandboxId || undefined}
          projectId={projectId}
        />
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
          defaultSize={shouldShowPanel ? 50 : 100}
          minSize={shouldShowPanel ? 30 : 100}
          maxSize={shouldShowPanel ? 65 : 100}
          className="flex flex-col overflow-hidden relative bg-transparent"
        >
          <SiteHeader
            threadId={threadId}
            projectName={projectName}
            projectId={projectId}
            onViewFiles={handleFileClick}
            onToggleSidePanel={onToggleSidePanel}
            isSidePanelOpen={isSidePanelOpen}
            onProjectRenamed={onProjectRenamed}
            isMobileView={isMobile}
            variant={variant}
          />

          <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
            {children}
          </div>

          {/* ChatInput - positioned at bottom of main content panel */}
          {chatInput && (
            <div className="flex-shrink-0 relative bg-background px-4">
              {chatInput}
            </div>
          )}
        </ResizablePanel>

        {/* Resizable handle - always enabled */}
        <ResizableHandle
          withHandle={true}
          disabled={false}
          className="z-20 w-0"
        />

        {/* Side panel - always render but control size */}
        <ResizablePanel
          ref={sidePanelRef}
          defaultSize={shouldShowPanel ? 50 : 0}
          minSize={shouldShowPanel ? 35 : 0}
          maxSize={shouldShowPanel ? 70 : 0}
          collapsible={true}
          className={cn(
            "relative bg-transparent",
            shouldShowPanel ? "pr-4 pb-5 pt-4" : "px-0",
            !shouldShowPanel ? "hidden" : ""
          )}
        >
          <KortixComputer
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
            onFileClick={handleFileClick}
            agentName={agentName}
            disableInitialAnimation={disableInitialAnimation}
            streamingText={streamingToolArgsJson}
            sandboxId={sandboxId || undefined}
            projectId={projectId}
            sidePanelRef={sidePanelRef}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
});
