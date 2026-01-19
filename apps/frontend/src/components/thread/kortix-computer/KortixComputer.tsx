'use client';

import { Project } from '@/lib/api/threads';
import { getUserFriendlyToolName, HIDE_BROWSER_TAB } from '@/components/thread/utils';
import { isHiddenTool } from '@agentpress/shared/tools';
import React, { memo, useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiMessageType } from '@/components/thread/types';
import { Globe, CircleDashed } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useIsMobile } from '@/hooks/utils';
import { ToolView } from '../tool-views/wrapper';
import { motion, AnimatePresence } from 'framer-motion';
import { HealthCheckedVncIframe } from '../HealthCheckedVncIframe';
import { BrowserHeader } from '../tool-views/BrowserToolView';
import { useTranslations } from 'next-intl';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';
import { 
  useKortixComputerStore,
  useKortixComputerPendingToolNavIndex,
  useKortixComputerClearPendingToolNav,
} from '@/stores/kortix-computer-store';
import { FileBrowserView } from './FileBrowserView';
import { FileViewerView } from './FileViewerView';
import { ToolCallData, ToolResultData } from '../tool-views/types';
import { PanelHeader } from './components/PanelHeader';
import { NavigationControls } from './components/NavigationControls';
import { EmptyState } from './components/EmptyState';
import { LoadingState } from './components/LoadingState';
import { AppDock } from './components/Dock';
import { SandboxDesktop } from './components/Desktop';
import { EnhancedFileBrowser } from './components/EnhancedFileBrowser';
import { useDirectoryQuery } from '@/hooks/files';
import { getToolNumber } from '@/hooks/messages/tool-tracking';

export interface ToolCallInput {
  toolCall: ToolCallData;
  toolResult?: ToolResultData;
  assistantTimestamp?: string;
  toolTimestamp?: string;
  isSuccess?: boolean;
  messages?: ApiMessageType[];
}

interface KortixComputerProps {
  isOpen: boolean;
  onClose: () => void;
  toolCalls: ToolCallInput[];
  currentIndex: number;
  onNavigate: (newIndex: number) => void;
  externalNavigateToIndex?: number;
  messages?: ApiMessageType[];
  agentStatus: string;
  project?: Project;
  renderAssistantMessage?: (
    assistantContent?: string,
    toolContent?: string,
  ) => React.ReactNode;
  renderToolResult?: (
    toolContent?: string,
    isSuccess?: boolean,
  ) => React.ReactNode;
  isLoading?: boolean;
  agentName?: string;
  onFileClick?: (filePath: string) => void;
  disableInitialAnimation?: boolean;
  compact?: boolean;
  streamingText?: string;
  sandboxId?: string;
  projectId?: string;
  sidePanelRef?: React.RefObject<any>;
}

interface ToolCallSnapshot {
  id: string;
  toolCall: ToolCallInput;
  index: number;
  timestamp: number;
}

type NavigationMode = 'live' | 'manual';

const FLOATING_LAYOUT_ID = 'kortix-computer-float';

export const KortixComputer = memo(function KortixComputer({
  isOpen,
  onClose,
  toolCalls,
  currentIndex,
  onNavigate,
  messages,
  agentStatus,
  project,
  isLoading = false,
  externalNavigateToIndex,
  agentName,
  onFileClick,
  disableInitialAnimation,
  compact = false,
  streamingText,
  sandboxId,
  projectId,
  sidePanelRef,
}: KortixComputerProps) {
  const t = useTranslations('thread');
  const [dots, setDots] = useState('');
  const [internalIndex, setInternalIndex] = useState(0);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('live');
  const [toolCallSnapshots, setToolCallSnapshots] = useState<ToolCallSnapshot[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [vncRefreshKey, setVncRefreshKey] = useState(0);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isSuiteMode, setIsSuiteMode] = useState(false);
  const [preSuiteSize, setPreSuiteSize] = useState<number | null>(null);

  const isMobile = useIsMobile();
  const { isOpen: isDocumentModalOpen } = useDocumentModalStore();
  const sandbox = project?.sandbox;

  const { 
    activeView, 
    filesSubView, 
    selectedFilePath,
    setActiveView,
    currentPath,
    navigateToPath,
    openFile,
  } = useKortixComputerStore();
  
  const pendingToolNavIndex = useKortixComputerPendingToolNavIndex();
  const clearPendingToolNav = useKortixComputerClearPendingToolNav();

  const effectiveSandboxIdForQuery = sandboxId || project?.sandbox?.id || '';
  const { data: enhancedBrowserFiles = [] } = useDirectoryQuery(
    effectiveSandboxIdForQuery, 
    currentPath, 
    { enabled: !!effectiveSandboxIdForQuery && isMaximized }
  );

  const currentViewRef = useRef(activeView);

  useEffect(() => {
    currentViewRef.current = activeView;
  }, [activeView]);

  // Track previous projectId and sandboxId to detect project/thread switches
  const prevProjectIdRef = useRef<string | null>(null);
  const prevSandboxIdRef = useRef<string | null>(null);
  
  // Reset local state when switching projects/threads or sandboxes
  useEffect(() => {
    const projectChanged = prevProjectIdRef.current !== null && prevProjectIdRef.current !== projectId;
    const sandboxChanged = prevSandboxIdRef.current !== null && prevSandboxIdRef.current !== sandboxId && sandboxId !== null;
    
    if (projectChanged || sandboxChanged) {
      console.log('[KortixComputer] Project or sandbox changed, resetting local state', { projectId, sandboxId });
      // Reset local component state
      setInternalIndex(0);
      setNavigationMode('live');
      setToolCallSnapshots([]);
      setIsInitialized(false);
      setIsMaximized(false);
      setIsSuiteMode(false);
      setPreSuiteSize(null);
    }
    prevProjectIdRef.current = projectId || null;
    prevSandboxIdRef.current = sandboxId || null;
  }, [projectId, sandboxId]);

  const handleVncRefresh = useCallback(() => {
    setVncRefreshKey(prev => prev + 1);
  }, []);

  const persistentVncIframe = useMemo(() => {
    if (!sandbox || !sandbox.vnc_preview || !sandbox.pass || !sandbox.id) return null;

    return (
      <div>
        <HealthCheckedVncIframe
          key={vncRefreshKey}
          sandbox={{
            id: sandbox.id,
            vnc_preview: sandbox.vnc_preview,
            pass: sandbox.pass
          }}
        />
      </div>
    );
  }, [sandbox, vncRefreshKey]);

  const isBrowserTool = useCallback((toolName: string | undefined): boolean => {
    if (!toolName) return false;
    const lowerName = toolName.toLowerCase();
    return [
      'browser-navigate-to',
      'browser-act',
      'browser-extract-content',
      'browser-screenshot'
    ].includes(lowerName);
  }, []);

  useEffect(() => {
    // Skip browser tab switching if flag is enabled
    if (HIDE_BROWSER_TAB) return;
    
    if (!isInitialized && toolCallSnapshots.length > 0) {
      const streamingSnapshot = toolCallSnapshots.find(snapshot =>
        snapshot.toolCall.toolResult === undefined
      );

      if (streamingSnapshot) {
        const toolName = streamingSnapshot.toolCall.toolCall?.function_name?.replace(/_/g, '-');
        const isStreamingBrowserTool = isBrowserTool(toolName);

        if (isStreamingBrowserTool) {
          setActiveView('browser');
        }
      } else if (agentStatus === 'running') {
        const hasBrowserTool = toolCallSnapshots.some(snapshot => {
          const toolName = snapshot.toolCall.toolCall?.function_name?.replace(/_/g, '-');
          return isBrowserTool(toolName);
        });

        if (hasBrowserTool) {
          setActiveView('browser');
        }
      }
    }
  }, [toolCallSnapshots, isInitialized, isBrowserTool, agentStatus, setActiveView]);

  useEffect(() => {
    // Skip browser tab switching if flag is enabled
    if (HIDE_BROWSER_TAB) return;
    
    if (activeView !== 'tools') return;
    
    const safeIndex = Math.min(internalIndex, Math.max(0, toolCallSnapshots.length - 1));
    const currentSnapshot = toolCallSnapshots[safeIndex];
    const isCurrentSnapshotBrowserTool = isBrowserTool(currentSnapshot?.toolCall.toolCall?.function_name?.replace(/_/g, '-'));

    if (agentStatus === 'idle') {
      if (isCurrentSnapshotBrowserTool && safeIndex === toolCallSnapshots.length - 1) {
        setActiveView('browser');
      }
    } else if (agentStatus === 'running') {
      const streamingSnapshot = toolCallSnapshots.find(snapshot =>
        snapshot.toolCall.toolResult === undefined
      );

      if (streamingSnapshot) {
        const toolName = streamingSnapshot.toolCall.toolCall?.function_name?.replace(/_/g, '-');
        const isStreamingBrowserTool = isBrowserTool(toolName);

        if (isStreamingBrowserTool) {
          setActiveView('browser');
        }
      }
    }
  }, [toolCallSnapshots, internalIndex, isBrowserTool, agentStatus, activeView, setActiveView]);

  const handleClose = useCallback(() => {
    setIsMaximized(false);
    onClose();
  }, [onClose]);

  const handleMaximize = useCallback(() => {
    setIsMaximized(!isMaximized);
  }, [isMaximized]);

  // Filter out hidden tools (internal/initialization tools) before creating snapshots
  const visibleToolCalls = useMemo(() => {
    return toolCalls.filter(tc => {
      const toolName = tc.toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || '';
      return !isHiddenTool(toolName);
    });
  }, [toolCalls]);

  const newSnapshots = useMemo(() => {
    return visibleToolCalls.map((toolCall, index) => ({
      id: `${index}-${toolCall.assistantTimestamp || Date.now()}`,
      toolCall,
      index,
      timestamp: Date.now(),
    }));
  }, [visibleToolCalls]);

  useEffect(() => {
    const hadSnapshots = toolCallSnapshots.length > 0;
    const hasNewSnapshots = newSnapshots.length > toolCallSnapshots.length;
    setToolCallSnapshots(newSnapshots);

    // Skip browser tab switching if flag is enabled
    if (!HIDE_BROWSER_TAB && hasNewSnapshots && agentStatus === 'running' && activeView === 'tools') {
      const newSnapshot = newSnapshots[newSnapshots.length - 1];
      const toolName = newSnapshot?.toolCall.toolCall?.function_name?.replace(/_/g, '-');
      const isNewBrowserTool = isBrowserTool(toolName);

      if (isNewBrowserTool && newSnapshot.toolCall.toolResult === undefined) {
        setActiveView('browser');
      }
    }

    if (!isInitialized && newSnapshots.length > 0) {
      const completedCount = newSnapshots.filter(s =>
        s.toolCall.toolResult !== undefined
      ).length;

      if (completedCount > 0) {
        // File operation tool names that should be prioritized
        const fileOpTools = ['create-file', 'edit-file', 'full-file-rewrite', 'read-file', 'delete-file'];
        
        // First, try to find the latest completed file operation
        let targetIndex = -1;
        for (let i = newSnapshots.length - 1; i >= 0; i--) {
          const snapshot = newSnapshots[i];
          const toolName = snapshot.toolCall.toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || '';
          if (snapshot.toolCall.toolResult !== undefined && fileOpTools.includes(toolName)) {
            targetIndex = i;
            break;
          }
        }
        
        // If no file operation found, fall back to the latest completed tool
        if (targetIndex === -1) {
          for (let i = newSnapshots.length - 1; i >= 0; i--) {
            const snapshot = newSnapshots[i];
            if (snapshot.toolCall.toolResult !== undefined) {
              targetIndex = i;
              break;
            }
          }
        }
        
        setInternalIndex(Math.max(0, targetIndex));
      } else {
        setInternalIndex(Math.max(0, newSnapshots.length - 1));
      }
      setIsInitialized(true);
    } else if (hasNewSnapshots && navigationMode === 'live') {
      setInternalIndex(newSnapshots.length - 1);
    } else if (hasNewSnapshots && navigationMode === 'manual') {
      const wasAtLatest = internalIndex === toolCallSnapshots.length - 1;
      const latestSnapshot = newSnapshots[newSnapshots.length - 1];
      const latestToolName = latestSnapshot?.toolCall.toolCall?.function_name?.replace(/_/g, '-').toLowerCase();
      const isLatestFileOp = latestToolName && ['create-file', 'edit-file', 'full-file-rewrite', 'read-file', 'delete-file'].includes(latestToolName);

      if ((wasAtLatest || isLatestFileOp) && agentStatus === 'running') {
        setNavigationMode('live');
        setInternalIndex(newSnapshots.length - 1);
      }
    }
  }, [toolCalls, navigationMode, toolCallSnapshots.length, isInitialized, internalIndex, agentStatus, newSnapshots, isBrowserTool, activeView, setActiveView]);

  useEffect(() => {
    if ((!isInitialized || navigationMode === 'manual') && toolCallSnapshots.length > 0) {
      setInternalIndex(Math.min(currentIndex, toolCallSnapshots.length - 1));
    }
  }, [currentIndex, toolCallSnapshots.length, isInitialized, navigationMode]);

  const { safeInternalIndex, currentSnapshot, currentToolCall, totalCalls, latestIndex, completedToolCalls, totalCompletedCalls } = useMemo(() => {
    const safeIndex = Math.min(internalIndex, Math.max(0, toolCallSnapshots.length - 1));
    const snapshot = toolCallSnapshots[safeIndex];
    const toolCall = snapshot?.toolCall;
    const total = toolCallSnapshots.length;
    const latest = Math.max(0, total - 1);

    const completed = toolCallSnapshots.filter(snapshot =>
      snapshot.toolCall.toolResult !== undefined
    );
    const completedCount = completed.length;

    return {
      safeInternalIndex: safeIndex,
      currentSnapshot: snapshot,
      currentToolCall: toolCall,
      totalCalls: total,
      latestIndex: latest,
      completedToolCalls: completed,
      totalCompletedCalls: completedCount
    };
  }, [internalIndex, toolCallSnapshots]);

  let displayToolCall = currentToolCall;
  let displayIndex = safeInternalIndex;
  const displayTotalCalls = totalCalls;

  const isCurrentToolStreaming = currentToolCall != null && currentToolCall.toolResult === undefined;

  const currentToolName = currentToolCall?.toolCall?.function_name?.replace(/_/g, '-').toLowerCase();
  
  // Track previous displayToolCall for render logging
  const prevDisplayToolCallRef = useRef<ToolCallInput | undefined>(undefined);
  
  // Log when a tool is rendered
  useEffect(() => {
    if (displayToolCall && displayToolCall !== prevDisplayToolCallRef.current) {
      const toolCallId = displayToolCall.toolCall?.tool_call_id;
      const functionName = displayToolCall.toolCall?.function_name;
      const hasResult = !!displayToolCall.toolResult;
      const isStreaming = !hasResult;
      
      prevDisplayToolCallRef.current = displayToolCall;
    }
  }, [displayToolCall, displayIndex]);

  // Always show the current streaming tool - this ensures streaming appears immediately
  // The tool view components handle showing appropriate loading states for their respective tools

  const isStreaming = displayToolCall != null && displayToolCall.toolResult === undefined;

  const getActualSuccess = (toolCall: ToolCallInput): boolean => {
    if (toolCall?.toolResult?.success !== undefined) {
      return toolCall.toolResult.success;
    }
    return toolCall?.isSuccess ?? true;
  };

  const isSuccess = isStreaming ? true : getActualSuccess(displayToolCall);

  const internalNavigate = useCallback((newIndex: number, source: string = 'internal') => {
    if (newIndex < 0 || newIndex >= totalCalls) return;

    const isNavigatingToLatest = newIndex === totalCalls - 1;
    setInternalIndex(newIndex);

    if (isNavigatingToLatest) {
      setNavigationMode('live');
    } else {
      setNavigationMode('manual');
    }

    if (source === 'user_explicit') {
      onNavigate(newIndex);
    }
  }, [totalCalls, onNavigate]);

  const isLiveMode = navigationMode === 'live';
  const pointerIndex = isLiveMode ? latestIndex : safeInternalIndex;

  const navigateToPrevious = useCallback(() => {
    if (pointerIndex > 0) {
      setNavigationMode('manual');
      internalNavigate(pointerIndex - 1, 'user_explicit');
    }
  }, [pointerIndex, internalNavigate]);

  const navigateToNext = useCallback(() => {
    if (pointerIndex < latestIndex) {
      const nextIndex = pointerIndex + 1;
      setNavigationMode(nextIndex === latestIndex ? 'live' : 'manual');
      internalNavigate(nextIndex, 'user_explicit');
    }
  }, [pointerIndex, latestIndex, internalNavigate]);

  const jumpToLive = useCallback(() => {
    setNavigationMode('live');
    setInternalIndex(latestIndex);
    internalNavigate(latestIndex, 'user_explicit');
  }, [latestIndex, internalNavigate]);

  const jumpToLatest = useCallback(() => {
    setNavigationMode('manual');
    setInternalIndex(latestIndex);
    internalNavigate(latestIndex, 'user_explicit');
  }, [latestIndex, internalNavigate]);

  const handleSliderChange = useCallback(([newValue]: [number]) => {
    const bounded = Math.max(0, Math.min(newValue, latestIndex));
    setNavigationMode(bounded === latestIndex ? 'live' : 'manual');
    internalNavigate(bounded, 'user_explicit');
  }, [latestIndex, internalNavigate]);

  const handleDockNavigate = useCallback((index: number) => {
    const bounded = Math.max(0, Math.min(index, latestIndex));
    setNavigationMode(bounded === latestIndex ? 'live' : 'manual');
    internalNavigate(bounded, 'user_explicit');
  }, [latestIndex, internalNavigate]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      const el = document.activeElement;
      if (el) {
        const tagName = el.tagName.toLowerCase();
        if (
          tagName === 'input' ||
          tagName === 'textarea' ||
          el.getAttribute('contenteditable') === 'true' ||
          el.closest('.cm-editor') ||
          el.closest('.ProseMirror')
        ) {
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        event.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose, isDocumentModalOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleSidebarToggle = (event: CustomEvent) => {
      if (event.detail.expanded) {
        handleClose();
      }
    };

    window.addEventListener(
      'sidebar-left-toggled',
      handleSidebarToggle as EventListener,
    );
    return () =>
      window.removeEventListener(
        'sidebar-left-toggled',
        handleSidebarToggle as EventListener,
      );
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (externalNavigateToIndex !== undefined && externalNavigateToIndex >= 0 && externalNavigateToIndex < totalCalls) {
      setActiveView('tools');
      internalNavigate(externalNavigateToIndex, 'external_click');
    }
  }, [externalNavigateToIndex, totalCalls, internalNavigate, setActiveView]);
  
  useEffect(() => {
    if (pendingToolNavIndex !== null && pendingToolNavIndex >= 0 && pendingToolNavIndex < totalCalls) {
      setActiveView('tools');
      internalNavigate(pendingToolNavIndex, 'external_click');
      clearPendingToolNav();
    }
  }, [pendingToolNavIndex, totalCalls, internalNavigate, setActiveView, clearPendingToolNav]);

  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      setDots((prev) => {
        if (prev === '...') return '';
        return prev + '.';
      });
    }, 500);

    return () => clearInterval(interval);
  }, [isStreaming]);


  if (!isOpen) {
    return null;
  }

  if (isLoading) {
    return <LoadingState agentName={agentName} onClose={handleClose} isMobile={isMobile} />;
  }

  const effectiveSandboxId = sandboxId || project?.sandbox?.id || '';

  const renderToolsView = () => {
    // If no tool calls at all, show empty state
    if (toolCallSnapshots.length === 0) {
      return <EmptyState t={t} />;
    }

    // Find the tool to display - prefer displayToolCall, fallback to latest streaming tool
    let toolToShow = displayToolCall;
    let toolIndex = displayIndex;
    let toolIsStreaming = isStreaming;
    
    // If displayToolCall is not available, find any streaming tool to show immediately
    if (!toolToShow && toolCallSnapshots.length > 0) {
      const streamingSnapshot = toolCallSnapshots.find(s => s.toolCall.toolResult === undefined);
      if (streamingSnapshot) {
        toolToShow = streamingSnapshot.toolCall;
        toolIndex = streamingSnapshot.index;
        toolIsStreaming = true;
      } else {
        // No streaming tool, show the latest completed one
        const latestSnapshot = toolCallSnapshots[toolCallSnapshots.length - 1];
        if (latestSnapshot) {
          toolToShow = latestSnapshot.toolCall;
          toolIndex = latestSnapshot.index;
          toolIsStreaming = false;
        }
      }
    }

    // Still no tool to show - shouldn't happen but fallback to empty state
    if (!toolToShow || !toolToShow.toolCall) {
      return <EmptyState t={t} />;
    }

    const toolSuccess = toolIsStreaming ? true : (toolToShow.toolResult?.success ?? toolToShow.isSuccess ?? true);

    return (
      <ToolView
        toolCall={toolToShow.toolCall}
        toolResult={toolToShow.toolResult}
        assistantTimestamp={toolToShow.assistantTimestamp}
        toolTimestamp={toolToShow.toolTimestamp}
        isSuccess={toolSuccess}
        isStreaming={toolIsStreaming}
        project={project}
        messages={messages}
        agentStatus={agentStatus}
        currentIndex={toolIndex}
        totalCalls={displayTotalCalls}
        onFileClick={onFileClick}
        streamingText={toolIsStreaming ? streamingText : undefined}
      />
    );
  };

  const renderFilesView = () => {
    if (filesSubView === 'viewer' && selectedFilePath) {
      return (
        <FileViewerView
          sandboxId={effectiveSandboxId}
          filePath={selectedFilePath}
          project={project}
          projectId={projectId}
        />
      );
    }

    return (
      <FileBrowserView
        sandboxId={effectiveSandboxId}
        project={project}
        projectId={projectId}
        variant="inline-library"
      />
    );
  };

  const renderFilesViewMaximized = () => {
    if (filesSubView === 'viewer' && selectedFilePath) {
      return (
        <FileViewerView
          sandboxId={effectiveSandboxId}
          filePath={selectedFilePath}
          project={project}
          projectId={projectId}
        />
      );
    }

    const pathSegments = currentPath.split('/').filter(Boolean);
    const parentPath = pathSegments.length > 1 
      ? '/' + pathSegments.slice(0, -1).join('/') 
      : '/workspace';

    return (
      <EnhancedFileBrowser
        files={enhancedBrowserFiles.map(f => ({
          name: f.name,
          path: f.path || `${currentPath}/${f.name}`,
          is_dir: f.is_dir,
          size: f.size || 0,
          mod_time: f.mod_time || '',
        }))}
        currentPath={currentPath}
        onNavigate={navigateToPath}
        onFileOpen={(path) => openFile(path)}
        onFileEdit={(path) => openFile(path)}
        onBack={() => navigateToPath(parentPath)}
        sandboxId={effectiveSandboxId}
      />
    );
  };

  const renderBrowserView = () => {
    // If browser tab is hidden, don't render browser view
    if (HIDE_BROWSER_TAB) {
      return null;
    }
    
    if (persistentVncIframe) {
      return (
        <div className="h-full flex flex-col overflow-hidden">
          <BrowserHeader isConnected={true} onRefresh={handleVncRefresh} />
          <div className="flex-1 overflow-hidden grid items-center">
            {persistentVncIframe}
          </div>
        </div>
      );
    }

    return (
      <div className="h-full flex flex-col overflow-hidden">
        <BrowserHeader isConnected={false} />
        <div className="flex-1 overflow-auto flex flex-col items-center justify-center p-8 bg-zinc-50 dark:bg-zinc-900/50">
          <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
            <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center border-2 border-zinc-200 dark:border-zinc-700">
              <Globe className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Browser not available
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                No active browser session available. The browser will appear here when a sandbox is created and Browser tools are used.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderContent = () => {
    return (
      <div className="flex flex-col h-full max-h-full max-w-full overflow-hidden min-w-0" style={{ contain: 'strict' }}>
        {!isMobile && (
          <PanelHeader
            agentName={agentName}
            onClose={handleClose}
            onMaximize={handleMaximize}
            isStreaming={isStreaming && activeView === 'tools'}
            variant="motion"
            currentView={activeView}
            onViewChange={setActiveView}
            showFilesTab={true}
            isMaximized={isMaximized}
            isSuiteMode={isSuiteMode}
            onToggleSuiteMode={() => {
              if (isSuiteMode) {
                // Exit suite mode - restore previous size
                if (preSuiteSize !== null && sidePanelRef?.current) {
                  sidePanelRef.current.resize(preSuiteSize);
                }
                setPreSuiteSize(null);
                setIsSuiteMode(false);
              } else {
                // Enter suite mode - save current size and maximize
                if (sidePanelRef?.current) {
                  const currentSize = sidePanelRef.current.getSize();
                  setPreSuiteSize(currentSize);
                  sidePanelRef.current.resize(70); // Max size from ResizablePanel config
                }
                setIsSuiteMode(true);
              }
            }}
          />
        )}
        <div className="flex-1 overflow-hidden max-w-full max-h-full min-w-0 min-h-0" style={{ contain: 'strict' }}>
          {activeView === 'tools' && renderToolsView()}
          {activeView === 'files' && renderFilesView()}
          {!HIDE_BROWSER_TAB && activeView === 'browser' && renderBrowserView()}
        </div>
      </div>
    );
  };

  if (isMobile) {
    const handleDrawerKeyDown = (e: React.KeyboardEvent) => {
      // Vaul drawers are dismissible by Escape by default.
      // Prevent Escape / Esc from closing the Kortix Computer.
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    return (
      <Drawer
        open={isOpen}
        onOpenChange={(open) => !open && handleClose()}
        // Never allow Esc/Escape to dismiss the Kortix Computer.
        // (Users commonly hit Escape in editors / sandbox UIs.)
        dismissible={false}
      >
        <DrawerContent
          className="h-[85vh] max-h-[85vh] overflow-hidden"
          style={{ contain: 'strict' }}
          onKeyDown={handleDrawerKeyDown}
        >
          <PanelHeader
            agentName={agentName}
            onClose={handleClose}
            variant="drawer"
            currentView={activeView}
            onViewChange={setActiveView}
            showFilesTab={true}
          />

          <div className="flex-1 flex flex-col overflow-hidden max-w-full max-h-full min-w-0 min-h-0" style={{ contain: 'strict' }}>
            {activeView === 'tools' && renderToolsView()}
            {activeView === 'files' && renderFilesView()}
            {!HIDE_BROWSER_TAB && activeView === 'browser' && renderBrowserView()}
          </div>

          {activeView === 'tools' && (displayTotalCalls > 1 || (isCurrentToolStreaming && totalCompletedCalls > 0)) && (
            <NavigationControls
              displayIndex={displayIndex}
              displayTotalCalls={displayTotalCalls}
              safeInternalIndex={safeInternalIndex}
              latestIndex={latestIndex}
              isLiveMode={isLiveMode}
              agentStatus={agentStatus}
              onPrevious={navigateToPrevious}
              onNext={navigateToNext}
              onSliderChange={handleSliderChange}
              onJumpToLive={jumpToLive}
              onJumpToLatest={jumpToLatest}
              isMobile={true}
            />
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  if (compact) {
    const compactNav = activeView === 'tools' && (displayTotalCalls > 1 || (isCurrentToolStreaming && totalCompletedCalls > 0)) && (
      <NavigationControls
        displayIndex={displayIndex}
        displayTotalCalls={displayTotalCalls}
        safeInternalIndex={safeInternalIndex}
        latestIndex={latestIndex}
        isLiveMode={isLiveMode}
        agentStatus={agentStatus}
        onPrevious={navigateToPrevious}
        onNext={navigateToNext}
        onSliderChange={handleSliderChange}
        onJumpToLive={jumpToLive}
        onJumpToLatest={jumpToLatest}
        isMobile={false}
      />
    );

    const compactDockNav = activeView === 'tools' && isMaximized ? (
      <AppDock
        toolCalls={toolCallSnapshots.map(s => s.toolCall)}
        currentIndex={safeInternalIndex}
        onNavigate={handleDockNavigate}
        onPrevious={navigateToPrevious}
        onNext={navigateToNext}
        latestIndex={latestIndex}
        agentStatus={agentStatus}
        isLiveMode={isLiveMode}
        onJumpToLive={jumpToLive}
        onJumpToLatest={jumpToLatest}
      />
    ) : null;

    if (isMaximized) {
      if (typeof document === 'undefined') return null;
      
      return createPortal(
        <div className="fixed inset-0 z-[9999] bg-background">
          <SandboxDesktop
            toolCalls={toolCallSnapshots.map(s => s.toolCall)}
            currentIndex={safeInternalIndex}
            onNavigate={handleDockNavigate}
            onPrevious={navigateToPrevious}
            onNext={navigateToNext}
            latestIndex={latestIndex}
            agentStatus={agentStatus}
            isLiveMode={isLiveMode}
            onJumpToLive={jumpToLive}
            onJumpToLatest={jumpToLatest}
            project={project}
            messages={messages}
            onFileClick={onFileClick}
            streamingText={streamingText}
            onClose={() => setIsMaximized(false)}
            currentView={activeView}
            onViewChange={setActiveView}
            renderFilesView={renderFilesViewMaximized}
            renderBrowserView={renderBrowserView}
            isStreaming={isStreaming}
            project_id={projectId}
          />
        </div>,
        document.body
      );
    }

    return (
      <AnimatePresence mode="wait">
        {isOpen && (
          <motion.div
            key="sidepanel"
            layoutId={FLOATING_LAYOUT_ID}
            initial={disableInitialAnimation ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              opacity: { duration: disableInitialAnimation ? 0 : 0.15 },
              layout: {
                type: "spring",
                stiffness: 400,
                damping: 35
              }
            }}
            className="m-4 h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] border rounded-3xl flex flex-col z-30 overflow-hidden"
            style={{
              contain: 'strict',
            }}
          >
            <div className="flex-1 flex flex-col overflow-hidden bg-card max-w-full max-h-full min-w-0 min-h-0" style={{ contain: 'strict' }}>
              {renderContent()}
            </div>
            {compactNav}
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  if (!isOpen) {
    return null;
  }

  const desktopNav = activeView === 'tools' && (displayTotalCalls > 1 || (isCurrentToolStreaming && totalCompletedCalls > 0)) && (
    <NavigationControls
      displayIndex={displayIndex}
      displayTotalCalls={displayTotalCalls}
      safeInternalIndex={safeInternalIndex}
      latestIndex={latestIndex}
      isLiveMode={isLiveMode}
      agentStatus={agentStatus}
      onPrevious={navigateToPrevious}
      onNext={navigateToNext}
      onSliderChange={handleSliderChange}
      onJumpToLive={jumpToLive}
      onJumpToLatest={jumpToLatest}
      isMobile={false}
    />
  );

  const dockNav = activeView === 'tools' && isMaximized ? (
    <AppDock
      toolCalls={toolCallSnapshots.map(s => s.toolCall)}
      currentIndex={safeInternalIndex}
      onNavigate={handleDockNavigate}
      onPrevious={navigateToPrevious}
      onNext={navigateToNext}
      latestIndex={latestIndex}
      agentStatus={agentStatus}
      isLiveMode={isLiveMode}
      onJumpToLive={jumpToLive}
      onJumpToLatest={jumpToLatest}
    />
  ) : null;

  if (isMaximized) {
    if (typeof document === 'undefined') return null;
    
    return createPortal(
      <div className="fixed inset-0 z-[9999] bg-background">
        <SandboxDesktop
          toolCalls={toolCallSnapshots.map(s => s.toolCall)}
          currentIndex={safeInternalIndex}
          onNavigate={handleDockNavigate}
          onPrevious={navigateToPrevious}
          onNext={navigateToNext}
          latestIndex={latestIndex}
          agentStatus={agentStatus}
          isLiveMode={isLiveMode}
          onJumpToLive={jumpToLive}
          onJumpToLatest={jumpToLatest}
          project={project}
          messages={messages}
          onFileClick={onFileClick}
          streamingText={streamingText}
          onClose={() => setIsMaximized(false)}
          currentView={activeView}
          onViewChange={setActiveView}
          renderFilesView={renderFilesViewMaximized}
          renderBrowserView={renderBrowserView}
          isStreaming={isStreaming}
          project_id={projectId}
        />
      </div>,
      document.body
    );
  }

  return (
    <motion.div
      key="sidepanel-resizable"
      layoutId="kortix-computer-window"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      transition={{
        layout: {
          type: "spring",
          stiffness: 400,
          damping: 30
        },
        opacity: {
          duration: 0.2
        }
      }}
      className="h-full w-full max-w-full max-h-full flex flex-col border rounded-3xl bg-card overflow-hidden min-w-0 min-h-0"
      style={{ contain: 'strict' }}
    >
      <div className="flex-1 flex flex-col overflow-hidden max-w-full max-h-full min-w-0 min-h-0" style={{ contain: 'strict' }}>
        {renderContent()}
      </div>
      {desktopNav}
    </motion.div>
  );
});
