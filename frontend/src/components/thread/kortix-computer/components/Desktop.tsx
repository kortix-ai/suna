'use client';

import { memo, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Folder, Globe } from 'lucide-react';
import { AppWindow } from './AppWindow';
import { AppDock } from './Dock';
import { PanelHeader } from './PanelHeader';
import { SandboxInfoCard } from './SandboxInfoCard';
import { ToolView } from '../../tool-views/wrapper';
import { getUserFriendlyToolName, getToolIcon } from '@/components/thread/utils';
import { ToolCallInput } from '../KortixComputer';
import { Project } from '@/lib/api/threads';
import { ApiMessageType } from '@/components/thread/types';
import { ViewType } from '@/stores/kortix-computer-store';
import { cn } from '@/lib/utils';
import { useSandboxDetails } from '@/hooks/files/use-sandbox-details';

const convertToolName = (toolName: string) => {
  if (toolName.includes('_')) {
    return toolName.replace(/_/g, '-');
  }
  return toolName;
};

const getToolColorScheme = (toolName: string): { bg: string; iconColor: string } => {
  const normalized = toolName?.toLowerCase() || '';

  if (normalized.includes('browser') || normalized.includes('web') || normalized.includes('crawl') || normalized.includes('scrape')) {
    return { bg: 'bg-gradient-to-br from-[#7CB9E8] to-[#5B9BD5]', iconColor: 'text-white' };
  }

  if (normalized.includes('file') || normalized.includes('create-file') || normalized.includes('edit-file') || normalized.includes('read-file') || normalized.includes('delete-file') || normalized.includes('full-file-rewrite') || normalized.includes('str-replace')) {
    return { bg: 'bg-gradient-to-br from-[#89A8C8] to-[#6B8DB5]', iconColor: 'text-white' };
  }

  if (normalized.includes('execute-command') || normalized.includes('terminal') || normalized.includes('command') || normalized.includes('check-command')) {
    return { bg: 'bg-gradient-to-br from-[#4A4A4A] to-[#333333]', iconColor: 'text-[#8FD9A8]' };
  }

  if (normalized.includes('search')) {
    return { bg: 'bg-gradient-to-br from-[#B8A9C9] to-[#9683A9]', iconColor: 'text-white' };
  }

  if (normalized.includes('task') || normalized.includes('complete') || normalized.includes('list')) {
    return { bg: 'bg-gradient-to-br from-[#E8B87D] to-[#D4956A]', iconColor: 'text-white' };
  }

  if (normalized.includes('phone') || normalized.includes('call') || normalized.includes('vapi')) {
    return { bg: 'bg-gradient-to-br from-[#8FBF9F] to-[#6FA380]', iconColor: 'text-white' };
  }

  if (normalized.includes('sheet') || normalized.includes('table')) {
    return { bg: 'bg-gradient-to-br from-[#9DD5B0] to-[#7ABF92]', iconColor: 'text-white' };
  }

  if (normalized.includes('slide') || normalized.includes('presentation')) {
    return { bg: 'bg-gradient-to-br from-[#92A8D1] to-[#7088B8]', iconColor: 'text-white' };
  }

  if (normalized.includes('ask') || normalized.includes('message')) {
    return { bg: 'bg-gradient-to-br from-[#A8D0E6] to-[#7FB3D3]', iconColor: 'text-white' };
  }

  if (normalized.includes('code') || normalized.includes('execute-code')) {
    return { bg: 'bg-gradient-to-br from-[#88C9C9] to-[#69AAAA]', iconColor: 'text-white' };
  }

  if (normalized.includes('network') || normalized.includes('data-provider') || normalized.includes('api')) {
    return { bg: 'bg-gradient-to-br from-[#E8A5A5] to-[#D08888]', iconColor: 'text-white' };
  }

  if (normalized.includes('mcp') || normalized.includes('plug') || normalized.includes('initialize')) {
    return { bg: 'bg-gradient-to-br from-[#C9A8D4] to-[#A888B8]', iconColor: 'text-white' };
  }

  if (normalized.includes('expose-port') || normalized.includes('computer')) {
    return { bg: 'bg-gradient-to-br from-[#8A8A8F] to-[#6A6A70]', iconColor: 'text-white' };
  }

  return { bg: 'bg-gradient-to-br from-[#A0A0A5] to-[#808085]', iconColor: 'text-white' };
};

interface OpenWindow {
  id: string;
  type: 'tool' | 'files' | 'browser';
  toolIndex?: number;
  zIndex: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  isMinimized: boolean;
}

interface SandboxDesktopProps {
  toolCalls: ToolCallInput[];
  currentIndex: number;
  onNavigate: (index: number) => void;
  onPrevious: () => void;
  onNext: () => void;
  latestIndex: number;
  agentStatus: string;
  isLiveMode: boolean;
  onJumpToLive: () => void;
  onJumpToLatest: () => void;
  project?: Project;
  messages?: ApiMessageType[];
  onFileClick?: (filePath: string) => void;
  streamingText?: string;
  onClose: () => void;
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  renderFilesView?: () => ReactNode;
  renderBrowserView?: () => ReactNode;
  isStreaming?: boolean;
  project_id: string;
}

export const SandboxDesktop = memo(function SandboxDesktop({
  toolCalls,
  currentIndex,
  onNavigate,
  onPrevious,
  onNext,
  latestIndex,
  agentStatus,
  isLiveMode,
  onJumpToLive,
  onJumpToLatest,
  project,
  messages,
  onFileClick,
  streamingText,
  onClose,
  currentView,
  onViewChange,
  renderFilesView,
  renderBrowserView,
  project_id,
  isStreaming = false,
}: SandboxDesktopProps) {
  const [openWindows, setOpenWindows] = useState<OpenWindow[]>([]);
  const [maxZIndex, setMaxZIndex] = useState(1);
  const [activeWindowId, setActiveWindowId] = useState<string | null>(null);

  const { data: sandboxDetails, isLoading: sandboxLoading, error: sandboxError } = useSandboxDetails(project_id);

  const getInitialPosition = useCallback((index: number) => {
    const baseX = 60 + (index % 5) * 40;
    const baseY = 40 + (index % 5) * 40;
    return { x: baseX, y: baseY };
  }, []);

  const openToolWindow = useCallback((toolIndex: number) => {
    const windowId = `tool-${toolIndex}`;
    
    setOpenWindows(prev => {
      const existing = prev.find(w => w.id === windowId);
      if (existing) {
        if (existing.isMinimized) {
          return prev.map(w => 
            w.id === windowId 
              ? { ...w, isMinimized: false, zIndex: maxZIndex + 1 }
              : w
          );
        }
        return prev.map(w => 
          w.id === windowId 
            ? { ...w, zIndex: maxZIndex + 1 }
            : w
        );
      }

      return [...prev, {
        id: windowId,
        type: 'tool' as const,
        toolIndex,
        zIndex: maxZIndex + 1,
        position: getInitialPosition(prev.length),
        size: { width: 700, height: 500 },
        isMinimized: false,
      }];
    });
    
    setMaxZIndex(prev => prev + 1);
    setActiveWindowId(windowId);
    onNavigate(toolIndex);
  }, [maxZIndex, getInitialPosition, onNavigate]);

  const openSystemWindow = useCallback((type: 'files' | 'browser') => {
    const windowId = `system-${type}`;
    
    setOpenWindows(prev => {
      const existing = prev.find(w => w.id === windowId);
      if (existing) {
        if (existing.isMinimized) {
          return prev.map(w => 
            w.id === windowId 
              ? { ...w, isMinimized: false, zIndex: maxZIndex + 1 }
              : w
          );
        }
        return prev.map(w => 
          w.id === windowId 
            ? { ...w, zIndex: maxZIndex + 1 }
            : w
        );
      }

      return [...prev, {
        id: windowId,
        type,
        zIndex: maxZIndex + 1,
        position: getInitialPosition(prev.length),
        size: { width: 900, height: 600 },
        isMinimized: false,
      }];
    });
    
    setMaxZIndex(prev => prev + 1);
    setActiveWindowId(windowId);
    onViewChange(type);
  }, [maxZIndex, getInitialPosition, onViewChange]);

  const closeWindow = useCallback((windowId: string) => {
    setOpenWindows(prev => prev.filter(w => w.id !== windowId));
    setActiveWindowId(prev => {
      if (prev === windowId) {
        const remaining = openWindows.filter(w => w.id !== windowId);
        if (remaining.length > 0) {
          const topWindow = remaining.reduce((a, b) => a.zIndex > b.zIndex ? a : b);
          return topWindow.id;
        }
        return null;
      }
      return prev;
    });
  }, [openWindows]);

  const minimizeWindow = useCallback((windowId: string) => {
    setOpenWindows(prev => prev.map(w => 
      w.id === windowId ? { ...w, isMinimized: true } : w
    ));
  }, []);

  const focusWindow = useCallback((windowId: string) => {
    setOpenWindows(prev => prev.map(w => 
      w.id === windowId ? { ...w, zIndex: maxZIndex + 1 } : w
    ));
    setMaxZIndex(prev => prev + 1);
    setActiveWindowId(windowId);
    
    const window = openWindows.find(w => w.id === windowId);
    if (window) {
      if (window.type === 'tool' && window.toolIndex !== undefined) {
        onNavigate(window.toolIndex);
        onViewChange('tools');
      } else if (window.type === 'files' || window.type === 'browser') {
        onViewChange(window.type);
      }
    }
  }, [maxZIndex, openWindows, onNavigate, onViewChange]);

  useEffect(() => {
    if (toolCalls.length > 0 && openWindows.length === 0) {
      openToolWindow(currentIndex);
    }
  }, []);

  useEffect(() => {
    if (toolCalls.length > 0 && currentIndex >= 0 && currentIndex < toolCalls.length) {
      openToolWindow(currentIndex);
    }
  }, [currentIndex]);

  useEffect(() => {
    if (toolCalls.length > 0 && latestIndex >= 0) {
      openToolWindow(latestIndex);
    }
  }, [latestIndex, toolCalls.length]);

  // When activeView changes externally (e.g., clicking Edit in FileOperationToolView), open the corresponding window
  const previousViewRef = useRef(currentView);
  useEffect(() => {
    // Only act if view actually changed
    if (previousViewRef.current === currentView) return;
    previousViewRef.current = currentView;
    
    if (currentView === 'files') {
      const existingFilesWindow = openWindows.find(w => w.type === 'files');
      if (!existingFilesWindow) {
        openSystemWindow('files');
      } else if (existingFilesWindow.isMinimized) {
        // Restore minimized window and bring to front
        setOpenWindows(prev => prev.map(w => 
          w.id === existingFilesWindow.id 
            ? { ...w, isMinimized: false, zIndex: maxZIndex + 1 }
            : w
        ));
        setMaxZIndex(prev => prev + 1);
        setActiveWindowId(existingFilesWindow.id);
      } else {
        // Bring existing window to front
        setOpenWindows(prev => prev.map(w => 
          w.id === existingFilesWindow.id 
            ? { ...w, zIndex: maxZIndex + 1 }
            : w
        ));
        setMaxZIndex(prev => prev + 1);
        setActiveWindowId(existingFilesWindow.id);
      }
    } else if (currentView === 'browser') {
      const existingBrowserWindow = openWindows.find(w => w.type === 'browser');
      if (!existingBrowserWindow) {
        openSystemWindow('browser');
      } else if (existingBrowserWindow.isMinimized) {
        setOpenWindows(prev => prev.map(w => 
          w.id === existingBrowserWindow.id 
            ? { ...w, isMinimized: false, zIndex: maxZIndex + 1 }
            : w
        ));
        setMaxZIndex(prev => prev + 1);
        setActiveWindowId(existingBrowserWindow.id);
      } else {
        setOpenWindows(prev => prev.map(w => 
          w.id === existingBrowserWindow.id 
            ? { ...w, zIndex: maxZIndex + 1 }
            : w
        ));
        setMaxZIndex(prev => prev + 1);
        setActiveWindowId(existingBrowserWindow.id);
      }
    }
  }, [currentView, openWindows, maxZIndex, openSystemWindow]);

  const handleDockNavigate = useCallback((index: number) => {
    openToolWindow(index);
    onViewChange('tools');
  }, [openToolWindow, onViewChange]);

  const handleSystemAppClick = useCallback((type: 'files' | 'browser') => {
    openSystemWindow(type);
  }, [openSystemWindow]);

  const isFilesWindowOpen = openWindows.some(w => w.id === 'system-files' && !w.isMinimized);
  const isBrowserWindowOpen = openWindows.some(w => w.id === 'system-browser' && !w.isMinimized);

  const getActualSuccess = (toolCall: ToolCallInput): boolean => {
    if (toolCall?.toolResult?.success !== undefined) {
      return toolCall.toolResult.success;
    }
    return toolCall?.isSuccess ?? true;
  };

  const visibleWindows = openWindows.filter(w => !w.isMinimized);
  const isDesktopEmpty = visibleWindows.length === 0;

  const renderDesktop = () => (
    <>
      <div className="absolute inset-0 top-14">
        <AnimatePresence>
          {isDesktopEmpty && (
            <SandboxInfoCard
              sandboxDetails={sandboxDetails}
              isLoading={sandboxLoading}
            />
          )}
          {visibleWindows.map(window => {
              if (window.type === 'tool' && window.toolIndex !== undefined) {
                const toolCall = toolCalls[window.toolIndex];
                if (!toolCall) return null;

                const toolName = toolCall.toolCall?.function_name || 'tool';
                const friendlyName = getUserFriendlyToolName(toolName);
                const ToolIcon = getToolIcon(convertToolName(toolName));
                const colorScheme = getToolColorScheme(convertToolName(toolName));
                const isToolStreaming = toolCall.toolResult === undefined;
                const isSuccess = isToolStreaming ? true : getActualSuccess(toolCall);

                return (
                  <AppWindow
                    key={window.id}
                    id={window.id}
                    title={friendlyName}
                    icon={
                      <div className={cn("w-4 h-4 rounded flex items-center justify-center", colorScheme.bg)}>
                        <ToolIcon className={cn("w-2.5 h-2.5", colorScheme.iconColor)} />
                      </div>
                    }
                    isActive={activeWindowId === window.id}
                    initialPosition={window.position}
                    initialSize={window.size}
                    onFocus={() => focusWindow(window.id)}
                    onClose={() => closeWindow(window.id)}
                    onMinimize={() => minimizeWindow(window.id)}
                    zIndex={window.zIndex}
                  >
                    <ToolView
                      toolCall={toolCall.toolCall}
                      toolResult={toolCall.toolResult}
                      assistantTimestamp={toolCall.assistantTimestamp}
                      toolTimestamp={toolCall.toolTimestamp}
                      isSuccess={isSuccess}
                      isStreaming={isToolStreaming}
                      project={project}
                      messages={messages}
                      agentStatus={agentStatus}
                      currentIndex={window.toolIndex}
                      totalCalls={toolCalls.length}
                      onFileClick={onFileClick}
                      streamingText={isToolStreaming ? streamingText : undefined}
                    />
                  </AppWindow>
                );
              }

              if (window.type === 'files' && renderFilesView) {
                return (
                  <AppWindow
                    key={window.id}
                    id={window.id}
                    title="Files"
                    icon={
                      <div className="w-4 h-4 rounded flex items-center justify-center bg-gradient-to-br from-[#89A8C8] to-[#6B8DB5]">
                        <Folder className="w-2.5 h-2.5 text-white" />
                      </div>
                    }
                    isActive={activeWindowId === window.id}
                    initialPosition={window.position}
                    initialSize={window.size}
                    onFocus={() => focusWindow(window.id)}
                    onClose={() => closeWindow(window.id)}
                    onMinimize={() => minimizeWindow(window.id)}
                    zIndex={window.zIndex}
                  >
                    {renderFilesView()}
                  </AppWindow>
                );
              }

              if (window.type === 'browser' && renderBrowserView) {
                return (
                  <AppWindow
                    key={window.id}
                    id={window.id}
                    title="Browser"
                    icon={
                      <div className="w-4 h-4 rounded flex items-center justify-center bg-gradient-to-br from-[#7CB9E8] to-[#5B9BD5]">
                        <Globe className="w-2.5 h-2.5 text-white" />
                      </div>
                    }
                    isActive={activeWindowId === window.id}
                    initialPosition={window.position}
                    initialSize={window.size}
                    onFocus={() => focusWindow(window.id)}
                    onClose={() => closeWindow(window.id)}
                    onMinimize={() => minimizeWindow(window.id)}
                    zIndex={window.zIndex}
                  >
                    {renderBrowserView()}
                  </AppWindow>
                );
              }

              return null;
            })}
        </AnimatePresence>
      </div>

      <AppDock
        toolCalls={toolCalls}
        currentIndex={currentIndex}
        onNavigate={handleDockNavigate}
        onPrevious={onPrevious}
        onNext={onNext}
        latestIndex={latestIndex}
        agentStatus={agentStatus}
        isLiveMode={isLiveMode}
        onJumpToLive={onJumpToLive}
        onJumpToLatest={onJumpToLatest}
        isMaximized={true}
        currentView={currentView}
        onViewChange={handleSystemAppClick}
        showFilesTab={true}
        isFilesWindowOpen={isFilesWindowOpen}
        isBrowserWindowOpen={isBrowserWindowOpen}
      />
    </>
  );

  return (
    <div className="relative w-full h-full overflow-hidden flex flex-col">
      <div className="absolute inset-0">
        <img 
          src="https://heprlhlltebrxydgtsjs.supabase.co/storage/v1/object/public/image-uploads/backgrounds/computer-bg-dark.jpg"
          alt="Desktop wallpaper"
          className="absolute inset-0 w-full h-full object-cover dark:block"
        />
        <img 
          src="https://heprlhlltebrxydgtsjs.supabase.co/storage/v1/object/public/image-uploads/backgrounds/computer-bg-light.jpg"
          alt="Desktop wallpaper"
          className="absolute inset-0 w-full h-full object-cover dark:hidden"
        />
        <div className="absolute inset-0 bg-black/10" />
      </div>

      <div className="relative z-50 flex-shrink-0">
        <PanelHeader
          onClose={onClose}
          onMinimize={onClose}
          onMaximize={() => {}}
          isStreaming={isStreaming}
          variant="motion"
          currentView={currentView}
          onViewChange={onViewChange}
          showFilesTab={false}
          isMaximized={true}
          hideViewToggle={true}
        />
      </div>

      <div className="relative flex-1 overflow-hidden">
        {renderDesktop()}
      </div>
    </div>
  );
});

SandboxDesktop.displayName = 'SandboxDesktop';
