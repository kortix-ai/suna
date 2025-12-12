'use client';

import { Project } from '@/lib/api/threads';
import { getUserFriendlyToolName } from '@/components/thread/utils';
import React, { memo, useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { Slider } from '@/components/ui/slider';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiMessageType } from '@/components/thread/types';
import { 
  CircleDashed, 
  X, 
  ChevronLeft, 
  ChevronRight, 
  Computer, 
  Minimize2, 
  Globe, 
  Zap,
  FolderOpen,
} from 'lucide-react';
import { useIsMobile } from '@/hooks/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ToolView } from '../tool-views/wrapper';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { HealthCheckedVncIframe } from '../HealthCheckedVncIframe';
import { BrowserHeader } from '../tool-views/BrowserToolView';
import { useTranslations } from 'next-intl';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';
import { 
  useKortixComputerStore, 
  ViewType,
  useKortixComputerPendingToolNavIndex,
  useKortixComputerClearPendingToolNav,
} from '@/stores/kortix-computer-store';
import { FileBrowserView } from './FileBrowserView';
import { FileViewerView } from './FileViewerView';

// ============================================================================
// Types & Interfaces
// ============================================================================

import { ToolCallData, ToolResultData } from '../tool-views/types';

/**
 * Structured tool call input - data comes directly from metadata
 */
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
}

interface ToolCallSnapshot {
  id: string;
  toolCall: ToolCallInput;
  index: number;
  timestamp: number;
}

type NavigationMode = 'live' | 'manual';

// ============================================================================
// Constants
// ============================================================================

const FLOATING_LAYOUT_ID = 'kortix-computer-float';
const CONTENT_LAYOUT_ID = 'kortix-computer-content';

// ============================================================================
// Sub-components
// ============================================================================

interface ViewToggleProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  showFilesTab?: boolean;
}

const ViewToggle = memo(function ViewToggle({ currentView, onViewChange, showFilesTab = true }: ViewToggleProps) {
  const viewOptions = showFilesTab 
    ? ['tools', 'files', 'browser'] as const
    : ['tools', 'browser'] as const;
  
  const getViewIndex = (view: ViewType) => {
    if (!showFilesTab && view === 'files') return 0;
    return viewOptions.indexOf(view as any);
  };
  
  const tabWidth = 28; // w-7 = 28px
  const gap = 4; // gap-1 = 4px
  
  return (
    <div className="relative flex items-center gap-1 bg-muted rounded-3xl px-1 py-1">
      <motion.div
        className="absolute top-1 left-1 h-7 w-7 bg-white dark:bg-zinc-700 rounded-xl shadow-sm"
        initial={false}
        animate={{
          x: getViewIndex(currentView) * (tabWidth + gap),
        }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30
        }}
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            onClick={() => onViewChange('tools')}
            className={`relative z-10 h-7 w-7 p-0 rounded-xl bg-transparent hover:bg-transparent shadow-none ${
              currentView === 'tools'
                ? 'text-black dark:text-white'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span>Actions</span>
        </TooltipContent>
      </Tooltip>

      {showFilesTab && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              onClick={() => onViewChange('files')}
              className={`relative z-10 h-7 w-7 p-0 rounded-xl bg-transparent hover:bg-transparent shadow-none ${
                currentView === 'files'
                  ? 'text-black dark:text-white'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Files</p>
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            onClick={() => onViewChange('browser')}
            className={`relative z-10 h-7 w-7 p-0 rounded-xl bg-transparent hover:bg-transparent shadow-none ${
              currentView === 'browser'
                ? 'text-black dark:text-white'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Browser</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
});

ViewToggle.displayName = 'ViewToggle';

// ============================================================================

interface PanelHeaderProps {
  agentName?: string;
  onClose: () => void;
  isStreaming?: boolean;
  variant?: 'drawer' | 'desktop' | 'motion';
  showMinimize?: boolean;
  layoutId?: string;
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  showFilesTab?: boolean;
}

const PanelHeader = memo(function PanelHeader({
  agentName,
  onClose,
  isStreaming = false,
  variant = 'desktop',
  showMinimize = false,
  layoutId,
  currentView,
  onViewChange,
  showFilesTab = true,
}: PanelHeaderProps) {
  const title = "Kortix Computer";

  if (variant === 'drawer') {
    return (
      <div className="h-14 flex-shrink-0 px-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
        <DrawerTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          {title}
        </DrawerTitle>
        <div className="flex items-center gap-2">
          <ViewToggle currentView={currentView} onViewChange={onViewChange} showFilesTab={showFilesTab} />
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
            title="Minimize"
          >
            <Minimize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  // Both motion and desktop variants use same fixed height header
  return (
    <div className="h-14 flex-shrink-0 px-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          {title}
        </h2>
        {isStreaming && (
          <div className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 flex items-center gap-1.5">
            <CircleDashed className="h-3 w-3 animate-spin" />
            <span>Running</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <ViewToggle currentView={currentView} onViewChange={onViewChange} showFilesTab={showFilesTab} />
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-8 w-8"
          title={showMinimize ? "Minimize" : "Close"}
        >
          {showMinimize ? <Minimize2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
});

PanelHeader.displayName = 'PanelHeader';

// ============================================================================

interface NavigationControlsProps {
  displayIndex: number;
  displayTotalCalls: number;
  safeInternalIndex: number;
  latestIndex: number;
  isLiveMode: boolean;
  agentStatus: string;
  onPrevious: () => void;
  onNext: () => void;
  onSliderChange: (value: number[]) => void;
  onJumpToLive: () => void;
  onJumpToLatest: () => void;
  isMobile?: boolean;
}

const NavigationControls = memo(function NavigationControls({
  displayIndex,
  displayTotalCalls,
  safeInternalIndex,
  latestIndex,
  isLiveMode,
  agentStatus,
  onPrevious,
  onNext,
  onSliderChange,
  onJumpToLive,
  onJumpToLatest,
  isMobile = false,
}: NavigationControlsProps) {
  const renderStatusButton = useCallback(() => {
    const baseClasses = "flex items-center justify-center gap-1.5 px-2 py-0.5 rounded-full w-[116px]";
    const dotClasses = "w-1.5 h-1.5 rounded-full";
    const textClasses = "text-xs font-medium";

    if (isLiveMode) {
      if (agentStatus === 'running') {
        return (
          <div
            className={`${baseClasses} bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors cursor-pointer`}
            onClick={onJumpToLive}
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
            onClick={onJumpToLive}
          >
            <div className={`${dotClasses} bg-green-500 animate-pulse`} />
            <span className={`${textClasses} text-green-700 dark:text-green-400`}>Jump to Live</span>
          </div>
        );
      } else {
        return (
          <div
            className={`${baseClasses} bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors cursor-pointer`}
            onClick={onJumpToLatest}
          >
            <div className={`${dotClasses} bg-blue-500`} />
            <span className={`${textClasses} text-blue-700 dark:text-blue-400`}>Jump to Latest</span>
          </div>
        );
      }
    }
  }, [isLiveMode, agentStatus, onJumpToLive, onJumpToLatest]);

  if (isMobile) {
    return (
      <div className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={onPrevious}
            disabled={displayIndex <= 0}
            className="h-8 px-2.5 text-xs"
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" />
            <span>Prev</span>
          </Button>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-600 dark:text-zinc-400 font-medium tabular-nums min-w-[44px]">
              {safeInternalIndex + 1}/{displayTotalCalls}
            </span>
            {renderStatusButton()}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={onNext}
            disabled={displayIndex >= displayTotalCalls - 1}
            className="h-8 px-2.5 text-xs"
          >
            <span>Next</span>
            <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onPrevious}
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
            onClick={onNext}
            disabled={safeInternalIndex >= latestIndex}
            className="h-7 w-7 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 relative">
          <Slider
            min={0}
            max={Math.max(0, displayTotalCalls - 1)}
            step={1}
            value={[safeInternalIndex]}
            onValueChange={onSliderChange}
            className="w-full [&>span:first-child]:h-1.5 [&>span:first-child]:bg-zinc-200 dark:[&>span:first-child]:bg-zinc-800 [&>span:first-child>span]:bg-zinc-500 dark:[&>span:first-child>span]:bg-zinc-400 [&>span:first-child>span]:h-1.5"
          />
        </div>

        <div className="flex items-center gap-1.5">
          {renderStatusButton()}
        </div>
      </div>
    </div>
  );
});

NavigationControls.displayName = 'NavigationControls';

// ============================================================================

interface EmptyStateProps {
  t: (key: string) => string;
}

const EmptyState = memo(function EmptyState({ t }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8">
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
            {t('noActionsYet')}
          </h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t('workerActionsDescription')}
          </p>
        </div>
      </div>
    </div>
  );
});

EmptyState.displayName = 'EmptyState';

// ============================================================================

interface LoadingStateProps {
  agentName?: string;
  onClose: () => void;
  isMobile: boolean;
}

const LoadingState = memo(function LoadingState({ agentName, onClose, isMobile }: LoadingStateProps) {
  const { activeView, setActiveView } = useKortixComputerStore();
  
  if (isMobile) {
    return (
      <DrawerContent className="h-[85vh]">
        <PanelHeader
          agentName={agentName}
          onClose={onClose}
          variant="drawer"
          currentView={activeView}
          onViewChange={setActiveView}
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
                onClose={onClose}
                showMinimize={true}
                currentView={activeView}
                onViewChange={setActiveView}
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
});

LoadingState.displayName = 'LoadingState';

// ============================================================================
// Main Component
// ============================================================================

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
}: KortixComputerProps) {
  const t = useTranslations('thread');
  const [dots, setDots] = useState('');
  const [internalIndex, setInternalIndex] = useState(0);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('live');
  const [toolCallSnapshots, setToolCallSnapshots] = useState<ToolCallSnapshot[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [vncRefreshKey, setVncRefreshKey] = useState(0);

  const isMobile = useIsMobile();
  const { isOpen: isDocumentModalOpen } = useDocumentModalStore();
  const sandbox = project?.sandbox;

  // Kortix Computer Store
  const { 
    activeView, 
    filesSubView, 
    selectedFilePath,
    setActiveView,
  } = useKortixComputerStore();
  
  // Pending tool navigation from store (triggered by clicking tool in ThreadContent)
  const pendingToolNavIndex = useKortixComputerPendingToolNavIndex();
  const clearPendingToolNav = useKortixComputerClearPendingToolNav();

  const currentViewRef = useRef(activeView);

  // Update ref when state changes
  useEffect(() => {
    currentViewRef.current = activeView;
  }, [activeView]);

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

  // Initialize view to browser if browser action is in progress when panel opens
  useEffect(() => {
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

  // Handle view toggle visibility and auto-switching logic
  useEffect(() => {
    // Only auto-switch when viewing tools
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
    onClose();
  }, [onClose]);

  const newSnapshots = useMemo(() => {
    return toolCalls.map((toolCall, index) => ({
      id: `${index}-${toolCall.assistantTimestamp || Date.now()}`,
      toolCall,
      index,
      timestamp: Date.now(),
    }));
  }, [toolCalls]);

  useEffect(() => {
    const hadSnapshots = toolCallSnapshots.length > 0;
    const hasNewSnapshots = newSnapshots.length > toolCallSnapshots.length;
    setToolCallSnapshots(newSnapshots);

    if (hasNewSnapshots && agentStatus === 'running' && activeView === 'tools') {
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
        let lastCompletedIndex = -1;
        for (let i = newSnapshots.length - 1; i >= 0; i--) {
          const snapshot = newSnapshots[i];
          if (snapshot.toolCall.toolResult !== undefined) {
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
  const isFileOperation = currentToolName && ['create-file', 'edit-file', 'full-file-rewrite', 'read-file', 'delete-file'].includes(currentToolName);

  if (isCurrentToolStreaming && totalCompletedCalls > 0 && !isFileOperation) {
    const lastCompletedSnapshot = completedToolCalls[completedToolCalls.length - 1];
    if (lastCompletedSnapshot?.toolCall?.toolCall) {
      displayToolCall = lastCompletedSnapshot.toolCall;
      displayIndex = completedToolCalls.length - 1;
    }
  }

  // Only streaming if we have a display tool call AND its result is undefined
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

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      // Skip if user is in an editable element (editor, input, textarea)
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

  // Handle external navigation from props (externalNavigateToIndex)
  useEffect(() => {
    if (externalNavigateToIndex !== undefined && externalNavigateToIndex >= 0 && externalNavigateToIndex < totalCalls) {
      // Always switch to tools view when externally navigating to a tool call
      setActiveView('tools');
      internalNavigate(externalNavigateToIndex, 'external_click');
    }
  }, [externalNavigateToIndex, totalCalls, internalNavigate, setActiveView]);
  
  // Handle pending tool navigation from store (triggered by clicking tool in ThreadContent)
  useEffect(() => {
    if (pendingToolNavIndex !== null && pendingToolNavIndex >= 0 && pendingToolNavIndex < totalCalls) {
      // Switch to tools view and navigate to the tool
      setActiveView('tools');
      internalNavigate(pendingToolNavIndex, 'external_click');
      // Clear the pending nav after processing
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

  // Back button is now handled within FileViewerView directly
  const effectiveSandboxId = sandboxId || project?.sandbox?.id || '';

  const renderToolsView = () => {
    if (!displayToolCall && toolCallSnapshots.length === 0) {
      return <EmptyState t={t} />;
    }

    if (!displayToolCall && toolCallSnapshots.length > 0) {
      const firstStreamingTool = toolCallSnapshots.find(s => s.toolCall.toolResult === undefined);
      if (firstStreamingTool && totalCompletedCalls === 0) {
        const toolName = firstStreamingTool.toolCall.toolCall?.function_name?.replace(/_/g, '-') || 'Tool';
        return (
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
                  {getUserFriendlyToolName(toolName)} is currently executing. Results will appear here when complete.
                </p>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className="h-full p-4">
          <div className="space-y-4">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        </div>
      );
    }

    if (!displayToolCall || !displayToolCall.toolCall) {
      return (
        <div className="h-full p-4">
          <div className="space-y-4">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        </div>
      );
    }

    return (
      <ToolView
        toolCall={displayToolCall.toolCall}
        toolResult={displayToolCall.toolResult}
        assistantTimestamp={displayToolCall.assistantTimestamp}
        toolTimestamp={displayToolCall.toolTimestamp}
        isSuccess={isSuccess}
        isStreaming={isStreaming}
        project={project}
        messages={messages}
        agentStatus={agentStatus}
        currentIndex={displayIndex}
        totalCalls={displayTotalCalls}
        onFileClick={onFileClick}
        streamingText={isStreaming ? streamingText : undefined}
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
      />
    );
  };

  const renderBrowserView = () => {
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
            isStreaming={isStreaming && activeView === 'tools'}
            variant="motion"
            currentView={activeView}
            onViewChange={setActiveView}
            showFilesTab={true}
          />
        )}

        <div className="flex-1 overflow-hidden max-w-full max-h-full min-w-0 min-h-0" style={{ contain: 'strict' }}>
          {activeView === 'tools' && renderToolsView()}
          {activeView === 'files' && renderFilesView()}
          {activeView === 'browser' && renderBrowserView()}
        </div>
      </div>
    );
  };

  // Mobile version - use drawer
  if (isMobile) {
    return (
      <Drawer open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DrawerContent className="h-[85vh] max-h-[85vh] overflow-hidden" style={{ contain: 'strict' }}>
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
            {activeView === 'browser' && renderBrowserView()}
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

  // Desktop compact mode
  if (compact) {
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
                isMobile={false}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  // Desktop version inside ResizablePanel - fill container
  if (!isOpen) {
    return null;
  }

  return (
    <motion.div
      key="sidepanel-resizable"
      initial={disableInitialAnimation ? { opacity: 1 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        opacity: {
          duration: disableInitialAnimation ? 0 : 0.2,
          ease: [0.4, 0, 0.2, 1]
        }
      }}
      className="h-full w-full max-w-full max-h-full flex flex-col border rounded-3xl bg-card overflow-hidden min-w-0 min-h-0"
      style={{ contain: 'strict' }}
    >
      <div className="flex-1 flex flex-col overflow-hidden max-w-full max-h-full min-w-0 min-h-0" style={{ contain: 'strict' }}>
        {renderContent()}
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
          isMobile={false}
        />
      )}
    </motion.div>
  );
});

