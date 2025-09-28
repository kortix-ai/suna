'use client';

import { Project } from '@/lib/api';
import { getToolIcon, getUserFriendlyToolName } from '@/components/thread/utils';
import React from 'react';
import { Slider } from '@/components/ui/slider';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiMessageType } from '@/components/thread/types';
import { CircleDashed, X, ChevronLeft, ChevronRight, Computer, Radio, Maximize2, Minimize2, Copy, Check, Globe, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ToolView } from './tool-views/wrapper';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { HealthCheckedVncIframe } from './HealthCheckedVncIframe';
import { BrowserHeader } from './tool-views/BrowserToolView';

import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { useDocumentModalStore } from '@/lib/stores/use-document-modal-store';

export interface ToolCallInput {
  assistantCall: {
    content?: string;
    name?: string;
    timestamp?: string;
  };
  toolResult?: {
    content?: string;
    isSuccess?: boolean;
    timestamp?: string;
  };
  messages?: ApiMessageType[];
}

interface ToolCallSidePanelProps {
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
}

interface ToolCallSnapshot {
  id: string;
  toolCall: ToolCallInput;
  index: number;
  timestamp: number;
}

const FLOATING_LAYOUT_ID = 'tool-panel-float';
const CONTENT_LAYOUT_ID = 'tool-panel-content';

interface ViewToggleProps {
  currentView: 'tools' | 'browser';
  onViewChange: (view: 'tools' | 'browser') => void;
}

const ViewToggle: React.FC<ViewToggleProps> = ({ currentView, onViewChange }) => {
  return (
    <div className="relative flex items-center gap-1 bg-muted rounded-3xl px-1 py-1">
      {/* Sliding background */}
      <motion.div
        className="absolute h-7 w-7 bg-white rounded-xl shadow-sm"
        initial={false}
        animate={{
          x: currentView === 'tools' ? 0 : 32, // 28px button width + 4px gap
        }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30
        }}
      />
      
      {/* Buttons */}
      <Button
        size="sm"
        onClick={() => onViewChange('tools')}
        className={`relative z-10 h-7 w-7 p-0 rounded-xl bg-transparent hover:bg-transparent shadow-none ${
          currentView === 'tools'
            ? 'text-black'
            : 'text-gray-500 dark:text-gray-400'
        }`}
        title="Switch to Tool View"
      >
        <Wrench className="h-3.5 w-3.5" />
      </Button>

      <Button
        size="sm"
        onClick={() => onViewChange('browser')}
        className={`relative z-10 h-7 w-7 p-0 rounded-xl bg-transparent hover:bg-transparent shadow-none ${
          currentView === 'browser'
            ? 'text-black'
            : 'text-gray-500 dark:text-gray-400'
        }`}
        title="Switch to Browser View"
      >
        <Globe className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
};

// Helper function to generate the computer title
const getComputerTitle = (agentName?: string): string => {
  return agentName ? `${agentName}'s Computer` : "Suna's Computer";
};

// Reusable header component for the tool panel
interface PanelHeaderProps {
  agentName?: string;
  onClose: () => void;
  isStreaming?: boolean;
  variant?: 'drawer' | 'desktop' | 'motion';
  showMinimize?: boolean;
  hasToolResult?: boolean;
  layoutId?: string;
}

const PanelHeader: React.FC<PanelHeaderProps> = ({
  agentName,
  onClose,
  isStreaming = false,
  variant = 'desktop',
  showMinimize = false,
  hasToolResult = false,
  layoutId,
}) => {
  const title = getComputerTitle(agentName);
  
  if (variant === 'drawer') {
    return (
      <DrawerHeader className="pb-2">
        <div className="flex items-center justify-between">
          <DrawerTitle className="text-lg font-medium">
            {title}
          </DrawerTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
            title="Minimize to floating preview"
          >
            <Minimize2 className="h-4 w-4" />
          </Button>
        </div>
      </DrawerHeader>
    );
  }

  if (variant === 'motion') {
    return (
      <motion.div
        layoutId={layoutId}
        className="p-3"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <motion.div layoutId="tool-icon" className="ml-2">
              <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
                {title}
              </h2>
            </motion.div>
          </div>

          <div className="flex items-center gap-2">
            {isStreaming && (
              <div className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 flex items-center gap-1.5">
                <CircleDashed className="h-3 w-3 animate-spin" />
                <span>Running</span>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8"
              title="Minimize to floating preview"
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <div className="pt-4 pl-4 pr-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="ml-2">
            <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
              {title}
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isStreaming && (
            <Badge variant="outline" className="gap-1.5 p-2 rounded-3xl">
              <CircleDashed className="h-3 w-3 animate-spin" />
              <span>Running</span>
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
            title={showMinimize ? "Minimize to floating preview" : "Close"}
          >
            {showMinimize ? <Minimize2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
};

export function ToolCallSidePanel({
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
}: ToolCallSidePanelProps) {
  const [dots, setDots] = React.useState('');
  const [internalIndex, setInternalIndex] = React.useState(0);
  const [navigationMode, setNavigationMode] = React.useState<'live' | 'manual'>('live');
  const [toolCallSnapshots, setToolCallSnapshots] = React.useState<ToolCallSnapshot[]>([]);
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [showViewToggle, setShowViewToggle] = React.useState(false);

  // Add copy functionality state
  const [isCopyingContent, setIsCopyingContent] = React.useState(false);
  // Add view toggle state  
  const [currentView, setCurrentView] = React.useState<'tools' | 'browser'>('tools');
  const currentViewRef = React.useRef(currentView);
  
  // Update ref when state changes
  React.useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  const isMobile = useIsMobile();
  const { isOpen: isDocumentModalOpen } = useDocumentModalStore();

  const sandbox = project?.sandbox;
  
  // Add refresh key state for VNC iframe
  const [vncRefreshKey, setVncRefreshKey] = React.useState(0);
  
  const handleVncRefresh = React.useCallback(() => {
    setVncRefreshKey(prev => prev + 1);
  }, []);

  const persistentVncIframe = React.useMemo(() => {
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

  // Helper function to check if a tool is browser-related
  const isBrowserTool = React.useCallback((toolName: string | undefined): boolean => {
    if (!toolName) return false;
    const lowerName = toolName.toLowerCase();
    return [
      'browser-navigate-to',
      'browser-act', 
      'browser-extract-content',
      'browser-screenshot'
    ].includes(lowerName);
  }, []);

  // Handle view toggle visibility and auto-switching logic
  React.useEffect(() => {
    const safeIndex = Math.min(internalIndex, Math.max(0, toolCallSnapshots.length - 1));
    const currentSnapshot = toolCallSnapshots[safeIndex];
    const isCurrentSnapshotBrowserTool = isBrowserTool(currentSnapshot?.toolCall.assistantCall?.name);
    setShowViewToggle(isCurrentSnapshotBrowserTool);
    
    // Handle view switching based on agent status
    if (agentStatus === 'idle') {
      // Switch to tools view when navigating to a non-browser tool
      if (!isCurrentSnapshotBrowserTool && currentViewRef.current === 'browser') {
        setCurrentView('tools');
      }
      // Switch to browser view when navigating to the latest browser tool
      if (isCurrentSnapshotBrowserTool && currentViewRef.current === 'tools' && safeIndex === toolCallSnapshots.length - 1) {
        setCurrentView('browser');
      }
    } else if (agentStatus === 'running') {
      // Auto-switch for streaming tools when agent is actively running
      const streamingSnapshot = toolCallSnapshots.find(snapshot => 
        snapshot.toolCall.toolResult?.content === 'STREAMING'
      );
      
      if (streamingSnapshot) {
        const streamingToolCall = streamingSnapshot.toolCall;
        const toolName = streamingToolCall.assistantCall?.name;
        const isStreamingBrowserTool = isBrowserTool(toolName);
        
        // Switch to browser view when a browser tool starts streaming and we're in tools view
        if (isStreamingBrowserTool && currentViewRef.current === 'tools') {
          setCurrentView('browser');
        }
        
        // Switch to tools view when a non-browser tool starts streaming and we're in browser view
        if (!isStreamingBrowserTool && currentViewRef.current === 'browser') {
          setCurrentView('tools');
        }
      }
    }
  }, [toolCallSnapshots, internalIndex, isBrowserTool, agentStatus]);

  const handleClose = React.useCallback(() => {
    onClose();
  }, [onClose]);

  React.useEffect(() => {
    const newSnapshots = toolCalls.map((toolCall, index) => ({
      id: `${index}-${toolCall.assistantCall.timestamp || Date.now()}`,
      toolCall,
      index,
      timestamp: Date.now(),
    }));

    const hadSnapshots = toolCallSnapshots.length > 0;
    const hasNewSnapshots = newSnapshots.length > toolCallSnapshots.length;
    setToolCallSnapshots(newSnapshots);

    if (!isInitialized && newSnapshots.length > 0) {
      const completedCount = newSnapshots.filter(s =>
        s.toolCall.toolResult?.content &&
        s.toolCall.toolResult.content !== 'STREAMING'
      ).length;

      if (completedCount > 0) {
        let lastCompletedIndex = -1;
        for (let i = newSnapshots.length - 1; i >= 0; i--) {
          const snapshot = newSnapshots[i];
          if (snapshot.toolCall.toolResult?.content &&
            snapshot.toolCall.toolResult.content !== 'STREAMING') {
            lastCompletedIndex = i;
            break;
          }
        }
        setInternalIndex(Math.max(0, lastCompletedIndex));
      } else {
        setInternalIndex(Math.max(0, newSnapshots.length - 1));
      }
      setIsInitialized(true);
    } else if (hasNewSnapshots && navigationMode === 'live') {
      // When in live mode and new snapshots arrive, always follow the true latest index.
      // Display stability for streaming is handled separately by displayToolCall logic.
      setInternalIndex(newSnapshots.length - 1);
    } else if (hasNewSnapshots && navigationMode === 'manual') {
      // When in manual mode and new snapshots arrive, check if we should auto-switch to live
      // This happens when the user was at the latest snapshot before new ones arrived
      const wasAtLatest = internalIndex === toolCallSnapshots.length - 1;
      if (wasAtLatest && agentStatus === 'running') {
        // Auto-switch to live mode when new snapshots arrive and we were at the latest
        setNavigationMode('live');
        setInternalIndex(newSnapshots.length - 1);
      }
    }
  }, [toolCalls, navigationMode, toolCallSnapshots.length, isInitialized, internalIndex, agentStatus]);

  React.useEffect(() => {
    // This is used to sync the internal index to the current index
    // Only sync when we're not in live mode, when we're initializing, and when there are tool calls
    if ((!isInitialized || navigationMode === 'manual') && toolCallSnapshots.length > 0) {
      setInternalIndex(Math.min(currentIndex, toolCallSnapshots.length - 1));
    }
  }, [currentIndex, toolCallSnapshots.length, isInitialized, navigationMode]);

  const safeInternalIndex = Math.min(internalIndex, Math.max(0, toolCallSnapshots.length - 1));
  const currentSnapshot = toolCallSnapshots[safeInternalIndex];
  const currentToolCall = currentSnapshot?.toolCall;
  const totalCalls = toolCallSnapshots.length;
  const latestIndex = Math.max(0, totalCalls - 1);

  const completedToolCalls = toolCallSnapshots.filter(snapshot =>
    snapshot.toolCall.toolResult?.content &&
    snapshot.toolCall.toolResult.content !== 'STREAMING'
  );
  const totalCompletedCalls = completedToolCalls.length;

  // Derive a user-facing timeline that is stable and easy to reason about:
  // - If the current tool is STREAMING, show the last completed result content;
  // - Counters/slider always show the full timeline length, but the index snaps to
  //   the last completed step while streaming so the user can still scrub.
  let displayToolCall = currentToolCall;
  let displayIndex = safeInternalIndex;
  let displayTotalCalls = totalCalls;
  const isAtTrueLatest = safeInternalIndex === latestIndex;

  const isCurrentToolStreaming = currentToolCall?.toolResult?.content === 'STREAMING';
  if (isCurrentToolStreaming && totalCompletedCalls > 0) {
    const lastCompletedSnapshot = completedToolCalls[completedToolCalls.length - 1];
    displayToolCall = lastCompletedSnapshot.toolCall;
    displayIndex = completedToolCalls.length - 1;
  }

  const currentToolName = displayToolCall?.assistantCall?.name || 'Tool Call';
  const CurrentToolIcon = getToolIcon(
    currentToolCall?.assistantCall?.name || 'unknown',
  );
  const isStreaming = displayToolCall?.toolResult?.content === 'STREAMING';

  // Extract actual success value from tool content with fallbacks
  const getActualSuccess = (toolCall: any): boolean => {
    const content = toolCall?.toolResult?.content;
    if (!content) return toolCall?.toolResult?.isSuccess ?? true;

    const safeParse = (data: any) => {
      try { return typeof data === 'string' ? JSON.parse(data) : data; }
      catch { return null; }
    };

    const parsed = safeParse(content);
    if (!parsed) return toolCall?.toolResult?.isSuccess ?? true;

    if (parsed.content) {
      const inner = safeParse(parsed.content);
      if (inner?.tool_execution?.result?.success !== undefined) {
        return inner.tool_execution.result.success;
      }
    }
    const success = parsed.tool_execution?.result?.success ??
      parsed.result?.success ??
      parsed.success;

    return success !== undefined ? success : (toolCall?.toolResult?.isSuccess ?? true);
  };

  const isSuccess = isStreaming ? true : getActualSuccess(displayToolCall);

  // Copy functions
  const copyToClipboard = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  }, []);

  const handleCopyContent = React.useCallback(async () => {
    const toolContent = displayToolCall?.toolResult?.content;
    if (!toolContent || toolContent === 'STREAMING') return;

    // Try to extract file content from tool result
    let fileContent = '';

    // If the tool result is JSON, try to extract file content
    try {
      const parsed = JSON.parse(toolContent);
      if (parsed.content && typeof parsed.content === 'string') {
        fileContent = parsed.content;
      } else if (parsed.file_content && typeof parsed.file_content === 'string') {
        fileContent = parsed.file_content;
      } else if (parsed.result && typeof parsed.result === 'string') {
        fileContent = parsed.result;
      } else if (parsed.toolOutput && typeof parsed.toolOutput === 'string') {
        fileContent = parsed.toolOutput;
      } else {
        // If no string content found, stringify the object
        fileContent = JSON.stringify(parsed, null, 2);
      }
    } catch (e) {
      // If it's not JSON, use the content as is
      fileContent = typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent, null, 2);
    }

    setIsCopyingContent(true);
    const success = await copyToClipboard(fileContent);
    if (success) {
      toast.success('File content copied to clipboard');
    } else {
      toast.error('Failed to copy file content');
    }
    setTimeout(() => setIsCopyingContent(false), 500);
  }, [displayToolCall?.toolResult?.content, copyToClipboard]);

  const internalNavigate = React.useCallback((newIndex: number, source: string = 'internal') => {
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

  const navigateToPrevious = React.useCallback(() => {
    if (pointerIndex > 0) {
      setNavigationMode('manual');
      internalNavigate(pointerIndex - 1, 'user_explicit');
    }
  }, [pointerIndex, internalNavigate]);

  const navigateToNext = React.useCallback(() => {
    if (pointerIndex < latestIndex) {
      const nextIndex = pointerIndex + 1;
      setNavigationMode(nextIndex === latestIndex ? 'live' : 'manual');
      internalNavigate(nextIndex, 'user_explicit');
    }
  }, [pointerIndex, latestIndex, internalNavigate]);

  const jumpToLive = React.useCallback(() => {
    setNavigationMode('live');
    setInternalIndex(latestIndex);
    internalNavigate(latestIndex, 'user_explicit');
  }, [latestIndex, internalNavigate]);

  const jumpToLatest = React.useCallback(() => {
    // For idle state: jump to the latest completed (same as latestIndex here)
    setNavigationMode('manual');
    setInternalIndex(latestIndex);
    internalNavigate(latestIndex, 'user_explicit');
  }, [latestIndex, internalNavigate]);

  const renderStatusButton = React.useCallback(() => {
    const baseClasses = "flex items-center justify-center gap-1.5 px-2 py-0.5 rounded-full w-[116px]";
    const dotClasses = "w-1.5 h-1.5 rounded-full";
    const textClasses = "text-xs font-medium";

    if (isLiveMode) {
      if (agentStatus === 'running') {
        return (
          <div
            className={`${baseClasses} bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors cursor-pointer`}
            onClick={jumpToLive}
          >
            <div className={`${dotClasses} bg-green-500 animate-pulse`} />
            <span className={`${textClasses} text-green-700 dark:text-green-400`}>Live Updates</span>
          </div>
        );
      } else {
        return (
          <div className={`${baseClasses} bg-neutral-50 dark:bg-neutral-900/20 border border-neutral-200 dark:border-neutral-800`}>
            <div className={`${dotClasses} bg-neutral-500`} />
            <span className={`${textClasses} text-neutral-700 dark:text-neutral-400`}>Latest Tool</span>
          </div>
        );
      }
    } else {
      if (agentStatus === 'running') {
        return (
          <div
            className={`${baseClasses} bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors cursor-pointer`}
            onClick={jumpToLive}
          >
            <div className={`${dotClasses} bg-green-500 animate-pulse`} />
            <span className={`${textClasses} text-green-700 dark:text-green-400`}>Jump to Live</span>
          </div>
        );
      } else {
        return (
          <div
            className={`${baseClasses} bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors cursor-pointer`}
            onClick={jumpToLatest}
          >
            <div className={`${dotClasses} bg-blue-500`} />
            <span className={`${textClasses} text-blue-700 dark:text-blue-400`}>Jump to Latest</span>
          </div>
        );
      }
    }
  }, [isLiveMode, agentStatus, jumpToLive, jumpToLatest]);

  const handleSliderChange = React.useCallback(([newValue]: [number]) => {
    // Slider maps directly over all snapshots for simplicity and correctness
    const bounded = Math.max(0, Math.min(newValue, latestIndex));
    setNavigationMode(bounded === latestIndex ? 'live' : 'manual');
    internalNavigate(bounded, 'user_explicit');
  }, [latestIndex, internalNavigate]);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle side panel shortcuts when document modal is open
      console.log('Side panel handler - document modal open:', isDocumentModalOpen, 'key:', event.key);
      if (isDocumentModalOpen) return;
      
      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        event.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose, isDocumentModalOpen]);

  React.useEffect(() => {
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

  React.useEffect(() => {
    if (externalNavigateToIndex !== undefined && externalNavigateToIndex >= 0 && externalNavigateToIndex < totalCalls) {
      internalNavigate(externalNavigateToIndex, 'external_click');
    }
  }, [externalNavigateToIndex, totalCalls, internalNavigate]);

  React.useEffect(() => {
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
    if (isMobile) {
      return (
        <Drawer open={isOpen} onOpenChange={(open) => !open && onClose()}>
          <DrawerContent className="h-[85vh]">
            <PanelHeader 
              agentName={agentName}
              onClose={handleClose}
              variant="drawer"
            />
            
            <div className="flex-1 p-4 overflow-auto">
              <div className="space-y-4">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-20 w-full rounded-md" />
                <Skeleton className="h-40 w-full rounded-md" />
                <Skeleton className="h-20 w-full rounded-md" />
              </div>
            </div>
          </DrawerContent>
        </Drawer>
      );
    }

    return (
      <div className="fixed inset-0 z-30 pointer-events-none">
        <div className="p-4 h-full flex items-stretch justify-end pointer-events-auto">
          <div className="border rounded-2xl flex flex-col shadow-2xl bg-background w-[90%] sm:w-[450px] md:w-[500px] lg:w-[550px] xl:w-[650px]">
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex flex-col h-full">
                <PanelHeader 
                  agentName={agentName}
                  onClose={handleClose}
                  showMinimize={true}
                />
                <div className="flex-1 p-4 overflow-auto">
                  <div className="space-y-4">
                    <Skeleton className="h-8 w-32" />
                    <Skeleton className="h-20 w-full rounded-md" />
                    <Skeleton className="h-40 w-full rounded-md" />
                    <Skeleton className="h-20 w-full rounded-md" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    if (!displayToolCall && toolCallSnapshots.length === 0) {
      return (
        <div className="flex flex-col h-full">
          {!isMobile && (
            <PanelHeader 
              agentName={agentName}
              onClose={handleClose}
            />
          )}
          <div className="flex flex-col items-center justify-center flex-1 p-8">
            <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
              <div className="relative">
                <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center">
                  <Computer className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
                </div>
                <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-zinc-200 dark:bg-zinc-700 rounded-full flex items-center justify-center">
                  <div className="w-2 h-2 bg-zinc-400 dark:text-zinc-500 rounded-full"></div>
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
                  No tool activity
                </h3>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                  Tool calls and computer interactions will appear here when they're being executed.
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (!displayToolCall && toolCallSnapshots.length > 0) {
      const firstStreamingTool = toolCallSnapshots.find(s => s.toolCall.toolResult?.content === 'STREAMING');
      if (firstStreamingTool && totalCompletedCalls === 0) {
        return (
          <div className="flex flex-col h-full">
            {!isMobile && (
              <PanelHeader 
                agentName={agentName}
                onClose={handleClose}
                isStreaming={true}
              />
            )}
            {isMobile && (
              <div className="px-4 pb-2">
                <div className="flex items-center justify-center">
                  <div className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 flex items-center gap-1.5">
                    <CircleDashed className="h-3 w-3 animate-spin" />
                    <span>Running</span>
                  </div>
                </div>
              </div>
            )}
            <div className="flex flex-col items-center justify-center flex-1 p-8">
              <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
                <div className="relative">
                  <div className="w-16 h-16 bg-blue-50 dark:bg-blue-900/20 rounded-full flex items-center justify-center">
                    <CircleDashed className="h-8 w-8 text-blue-500 dark:text-blue-400 animate-spin" />
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
                    Tool is running
                  </h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    {getUserFriendlyToolName(firstStreamingTool.toolCall.assistantCall.name || 'Tool')} is currently executing. Results will appear here when complete.
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className="flex flex-col h-full">
          {!isMobile && (
            <PanelHeader 
              agentName={agentName}
              onClose={handleClose}
            />
          )}
          <div className="flex-1 p-4 overflow-auto">
            <div className="space-y-4">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-20 w-full rounded-md" />
            </div>
          </div>
        </div>
      );
    }

    const toolView = (
      <ToolView
        name={displayToolCall.assistantCall.name}
        assistantContent={displayToolCall.assistantCall.content}
        toolContent={displayToolCall.toolResult?.content}
        assistantTimestamp={displayToolCall.assistantCall.timestamp}
        toolTimestamp={displayToolCall.toolResult?.timestamp}
        isSuccess={isSuccess}
        isStreaming={isStreaming}
        project={project}
        messages={messages}
        agentStatus={agentStatus}
        currentIndex={displayIndex}
        totalCalls={displayTotalCalls}
        onFileClick={onFileClick}
        viewToggle={<ViewToggle currentView={currentView} onViewChange={setCurrentView} />}  
      />
    );

    return (
      <div className="flex flex-col h-full">
        {!isMobile && (
          <PanelHeader 
            agentName={agentName}
            onClose={handleClose}
            isStreaming={isStreaming}
            variant="motion"
            hasToolResult={!!displayToolCall.toolResult?.content}
            layoutId={CONTENT_LAYOUT_ID}
          />
        )}

        <div className={`flex-1 ${currentView === 'browser' ? 'overflow-hidden' : 'overflow-hidden'} scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 scrollbar-track-transparent`}>
          {/* Always render VNC iframe to maintain connection when available */}
          {persistentVncIframe && (
            <div className={`${currentView === 'browser' ? 'h-full flex flex-col' : 'hidden'}`}>
              <BrowserHeader isConnected={true} onRefresh={handleVncRefresh} viewToggle={<ViewToggle currentView={currentView} onViewChange={setCurrentView} />} />
              {/* VNC iframe container - unchanged */}
              <div className="flex-1 overflow-hidden grid items-center">
                {persistentVncIframe}
              </div>
            </div>
          )}
          
          {/* Show browser not available message when no VNC and browser tab is selected */}
          {!persistentVncIframe && currentView === 'browser' && (
            <div className="h-full flex flex-col">
              <BrowserHeader isConnected={false} viewToggle={<ViewToggle currentView={currentView} onViewChange={setCurrentView} />} />
              
              {/* Message content */}
              <div className="flex-1 flex flex-col items-center justify-center p-8 bg-zinc-50 dark:bg-zinc-900/50">
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
          )}
          
          {/* Render tool view when tools tab is selected */}
          {currentView === 'tools' && toolView}
        </div>
      </div>
    );
  };

  // Mobile version - use drawer
  if (isMobile) {
    return (
      <Drawer open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DrawerContent className="h-[85vh]">
          <PanelHeader 
            agentName={agentName}
            onClose={handleClose}
            variant="drawer"
          />
          
          <div className="flex-1 flex flex-col overflow-hidden">
            {renderContent()}
          </div>
          
          {(displayTotalCalls > 1 || (isCurrentToolStreaming && totalCompletedCalls > 0)) && (
            <div className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={navigateToPrevious}
                  disabled={displayIndex <= 0}
                  className="h-8 px-2.5 text-xs"
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                  <span>Prev</span>
                </Button>

                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-zinc-600 dark:text-zinc-400 font-medium tabular-nums min-w-[44px]">
                    {safeInternalIndex + 1}/{totalCalls}
                  </span>
                  {renderStatusButton()}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={navigateToNext}
                  disabled={displayIndex >= displayTotalCalls - 1}
                  className="h-8 px-2.5 text-xs"
                >
                  <span>Next</span>
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  // Desktop version - use fixed panel
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
          className={compact 
            ? "m-4 h-[calc(100%-2rem)] w-[calc(100%-2rem)] border rounded-3xl flex flex-col z-30"
            : "fixed top-2 right-2 bottom-4 border rounded-3xl flex flex-col z-30 w-[40vw] sm:w-[450px] md:w-[500px] lg:w-[550px] xl:w-[645px]"
          }
          style={{
            overflow: 'hidden',
          }}
        >
          <div className="flex-1 flex flex-col overflow-hidden bg-card">
            {renderContent()}
          </div>
          {(displayTotalCalls > 1 || (isCurrentToolStreaming && totalCompletedCalls > 0)) && (
            <div className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-4 py-2.5">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={navigateToPrevious}
                    disabled={displayIndex <= 0}
                    className="h-7 w-7 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400 font-medium tabular-nums px-1 min-w-[44px] text-center">
                    {displayIndex + 1}/{displayTotalCalls}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={navigateToNext}
                    disabled={safeInternalIndex >= latestIndex}
                    className="h-7 w-7 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex-1 relative">
                  <Slider
                    min={0}
                    max={Math.max(0, totalCalls - 1)}
                    step={1}
                    value={[safeInternalIndex]}
                    onValueChange={handleSliderChange}
                    className="w-full [&>span:first-child]:h-1.5 [&>span:first-child]:bg-zinc-200 dark:[&>span:first-child]:bg-zinc-800 [&>span:first-child>span]:bg-zinc-500 dark:[&>span:first-child>span]:bg-zinc-400 [&>span:first-child>span]:h-1.5"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  {renderStatusButton()}
                </div>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
