'use client';

import { Project } from '@/lib/api/projects';
import { getUserFriendlyToolName } from '@/components/thread/utils';
import React, { memo, useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { Slider } from '@/components/ui/slider';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiMessageType } from '@/components/thread/types';
import { CircleDashed, X, ChevronLeft, ChevronRight, Computer, Minimize2, Globe, Wrench } from 'lucide-react';
import { useIsMobile } from '@/hooks/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ToolView } from './tool-views/wrapper';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { HealthCheckedVncIframe } from './HealthCheckedVncIframe';
import { BrowserHeader } from './tool-views/BrowserToolView';
import { useTranslations } from 'next-intl';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';

// ============================================================================
// Types & Interfaces
// ============================================================================

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

type NavigationMode = 'live' | 'manual';
type ViewType = 'tools' | 'browser';

// ============================================================================
// Constants
// ============================================================================

const FLOATING_LAYOUT_ID = 'tool-panel-float';
const CONTENT_LAYOUT_ID = 'tool-panel-content';

// ============================================================================
// Sub-components
// ============================================================================

interface ViewToggleProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
}

const ViewToggle = memo(function ViewToggle({ currentView, onViewChange }: ViewToggleProps) {
  return (
    <div className="relative flex items-center gap-1 bg-muted rounded-3xl px-1 py-1">
      <motion.div
        className="absolute h-7 w-7 bg-white rounded-xl shadow-sm"
        initial={false}
        animate={{
          x: currentView === 'tools' ? 0 : 32,
        }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30
        }}
      />
      
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
}

const PanelHeader = memo(function PanelHeader({
  agentName,
  onClose,
  isStreaming = false,
  variant = 'desktop',
  showMinimize = false,
  layoutId,
}: PanelHeaderProps) {
  const title = agentName ? `${agentName}'s Computer` : "Suna's Computer";
  
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
      <div className="p-3">
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
      </div>
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
  if (isMobile) {
    return (
      <DrawerContent className="h-[85vh]">
        <PanelHeader 
          agentName={agentName}
          onClose={onClose}
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
  const t = useTranslations('thread');
  const [dots, setDots] = useState('');
  const [internalIndex, setInternalIndex] = useState(0);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('live');
  const [toolCallSnapshots, setToolCallSnapshots] = useState<ToolCallSnapshot[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [currentView, setCurrentView] = useState<ViewType>('tools');
  const currentViewRef = useRef(currentView);
  const [vncRefreshKey, setVncRefreshKey] = useState(0);

  const isMobile = useIsMobile();
  const { isOpen: isDocumentModalOpen } = useDocumentModalStore();
  const sandbox = project?.sandbox;

  // Update ref when state changes
  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

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

  // Handle view toggle visibility and auto-switching logic
  useEffect(() => {
    const safeIndex = Math.min(internalIndex, Math.max(0, toolCallSnapshots.length - 1));
    const currentSnapshot = toolCallSnapshots[safeIndex];
    const isCurrentSnapshotBrowserTool = isBrowserTool(currentSnapshot?.toolCall.assistantCall?.name);
    
    if (agentStatus === 'idle') {
      if (!isCurrentSnapshotBrowserTool && currentViewRef.current === 'browser') {
        setCurrentView('tools');
      }
      if (isCurrentSnapshotBrowserTool && currentViewRef.current === 'tools' && safeIndex === toolCallSnapshots.length - 1) {
        setCurrentView('browser');
      }
    } else if (agentStatus === 'running') {
      const streamingSnapshot = toolCallSnapshots.find(snapshot => 
        snapshot.toolCall.toolResult?.content === 'STREAMING'
      );
      
      if (streamingSnapshot) {
        const streamingToolCall = streamingSnapshot.toolCall;
        const toolName = streamingToolCall.assistantCall?.name;
        const isStreamingBrowserTool = isBrowserTool(toolName);
        
        if (isStreamingBrowserTool && currentViewRef.current === 'tools') {
          setCurrentView('browser');
        }
        
        if (!isStreamingBrowserTool && currentViewRef.current === 'browser') {
          setCurrentView('tools');
        }
      }
    }
  }, [toolCallSnapshots, internalIndex, isBrowserTool, agentStatus]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const newSnapshots = useMemo(() => {
    return toolCalls.map((toolCall, index) => ({
      id: `${index}-${toolCall.assistantCall.timestamp || Date.now()}`,
      toolCall,
      index,
      timestamp: Date.now(),
    }));
  }, [toolCalls]);

  useEffect(() => {
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
      setInternalIndex(newSnapshots.length - 1);
    } else if (hasNewSnapshots && navigationMode === 'manual') {
      const wasAtLatest = internalIndex === toolCallSnapshots.length - 1;
      if (wasAtLatest && agentStatus === 'running') {
        setNavigationMode('live');
        setInternalIndex(newSnapshots.length - 1);
      }
    }
  }, [toolCalls, navigationMode, toolCallSnapshots.length, isInitialized, internalIndex, agentStatus, newSnapshots]);

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
      snapshot.toolCall.toolResult?.content &&
      snapshot.toolCall.toolResult.content !== 'STREAMING'
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

  const isCurrentToolStreaming = currentToolCall?.toolResult?.content === 'STREAMING';
  if (isCurrentToolStreaming && totalCompletedCalls > 0) {
    const lastCompletedSnapshot = completedToolCalls[completedToolCalls.length - 1];
    displayToolCall = lastCompletedSnapshot.toolCall;
    displayIndex = completedToolCalls.length - 1;
  }

  const isStreaming = displayToolCall?.toolResult?.content === 'STREAMING';

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

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  }, []);

  const handleCopyContent = useCallback(async () => {
    const toolContent = displayToolCall?.toolResult?.content;
    if (!toolContent || toolContent === 'STREAMING') return;

    let fileContent = '';

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
        fileContent = JSON.stringify(parsed, null, 2);
      }
    } catch (e) {
      fileContent = typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent, null, 2);
    }

    const success = await copyToClipboard(fileContent);
    if (success) {
      toast.success('File content copied to clipboard');
    } else {
      toast.error('Failed to copy file content');
    }
  }, [displayToolCall?.toolResult?.content, copyToClipboard]);

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
      internalNavigate(externalNavigateToIndex, 'external_click');
    }
  }, [externalNavigateToIndex, totalCalls, internalNavigate]);

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
          <EmptyState t={t} />
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
          />
        )}

        <div className={`flex-1 ${currentView === 'browser' ? 'overflow-hidden' : 'overflow-hidden'} scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 scrollbar-track-transparent`}>
          {persistentVncIframe && (
            <div className={`${currentView === 'browser' ? 'h-full flex flex-col' : 'hidden'}`}>
              <BrowserHeader isConnected={true} onRefresh={handleVncRefresh} viewToggle={<ViewToggle currentView={currentView} onViewChange={setCurrentView} />} />
              <div className="flex-1 overflow-hidden grid items-center">
                {persistentVncIframe}
              </div>
            </div>
          )}
          
          {!persistentVncIframe && currentView === 'browser' && (
            <div className="h-full flex flex-col">
              <BrowserHeader isConnected={false} viewToggle={<ViewToggle currentView={currentView} onViewChange={setCurrentView} />} />
              
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

  // Desktop version
  // When compact=true, use fixed overlay positioning
  // When compact=false, assume it's inside a ResizablePanel and fill the container
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
            className="m-4 h-[calc(100%-2rem)] w-[calc(100%-2rem)] border rounded-3xl flex flex-col z-30"
            style={{
              overflow: 'hidden',
            }}
          >
            <div className="flex-1 flex flex-col overflow-hidden bg-card">
              {renderContent()}
            </div>
            {(displayTotalCalls > 1 || (isCurrentToolStreaming && totalCompletedCalls > 0)) && (
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
      className="h-full w-full flex flex-col border rounded-3xl bg-card overflow-hidden"
    >
          <div className="flex-1 flex flex-col overflow-hidden">
            {renderContent()}
          </div>
          {(displayTotalCalls > 1 || (isCurrentToolStreaming && totalCompletedCalls > 0)) && (
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
}
