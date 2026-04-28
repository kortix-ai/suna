'use client';

import { memo, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Folder, Globe, TerminalSquare, Info, Table } from 'lucide-react';
import { AppWindow } from './AppWindow';
import { AppDock } from './Dock';
import { PanelHeader } from './PanelHeader';
import { ToolView } from '../../tool-views/wrapper';
import { getUserFriendlyToolName, getToolIcon } from '@/components/thread/utils';
import { ToolCallInput } from '../KortixComputer';
import { Project } from '@/types/project';

import { ViewType } from '@/stores/kortix-computer-store';
import { cn } from '@/lib/utils';
import { useFileList, fileListKeys, useFileUpload, useFileMkdir, useFileDelete, useFileRename, useFilesStore, FileBrowser, FileViewer, FileHistoryPanel, downloadFile } from '@/features/files';
import { DesktopContextMenu } from './DesktopContextMenu';
import { QuickLaunch } from './QuickLaunch';
import { DesktopIcons } from './DesktopIcons';
import { SSHTerminal } from './SSHTerminal';
import { getFileIconByName } from './Icons';
import { SystemInfoContent } from './SystemInfoContent';
import { FileInfoContent, FileInfo } from './FileInfoContent';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { toast } from '@/lib/toast';

// Lazy load SpreadsheetApp as it imports Syncfusion (~1-2 MB)
const SpreadsheetApp = dynamic(
  () => import('./SpreadsheetApp').then((mod) => mod.SpreadsheetApp),
  { ssr: false, loading: () => <div className="flex items-center justify-center h-full text-muted-foreground">Loading spreadsheet...</div> }
);
import { useQueryClient } from '@tanstack/react-query';

const convertToolName = (toolName: string) => {
  if (toolName.includes('_')) {
    return toolName.replace(/_/g, '-');
  }
  return toolName;
};

const getToolColorScheme = (_toolName: string): { bg: string; iconColor: string } => {
  // All tools use a consistent gray color scheme
  return { bg: 'bg-gradient-to-br from-zinc-500 to-zinc-600', iconColor: 'text-white' };
};

interface OpenWindow {
  id: string;
  type: 'tool' | 'files' | 'browser' | 'terminal' | 'file-viewer' | 'folder-browser' | 'info' | 'file-info' | 'spreadsheet';
  toolIndex?: number;
  filePath?: string;
  fileName?: string;
  fileInfo?: FileInfo;
  zIndex: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  isMinimized: boolean;
}

interface FolderWindowProps {
  window: OpenWindow;
  sandboxId: string;
  isActive: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
}

/**
 * Wrapper that sets files store state before rendering the unified FileViewer.
 * Used for Desktop individual file windows. Supports switching to history view.
 */
const DesktopFileViewer = memo(function DesktopFileViewer({ filePath }: { filePath: string }) {
  const openFile = useFilesStore((s) => s.openFile);
  const view = useFilesStore((s) => s.view);
  const historyFilePath = useFilesStore((s) => s.historyFilePath);
  useEffect(() => {
    openFile(filePath);
  }, [filePath, openFile]);

  if (view === 'history' && historyFilePath) {
    return <FileHistoryPanel />;
  }
  return <FileViewer />;
});

/**
 * Wrapper that sets files store state before rendering the unified FileBrowser.
 * Used for Desktop folder windows.
 */
const DesktopFolderBrowser = memo(function DesktopFolderBrowser({ folderPath }: { folderPath?: string }) {
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  useEffect(() => {
    navigateToPath(folderPath || '.');
  }, [folderPath, navigateToPath]);
  return <FileBrowser />;
});

const FolderWindow = memo(function FolderWindow({
  window,
  sandboxId,
  isActive,
  onFocus,
  onClose,
  onMinimize,
}: FolderWindowProps) {
  const folderName = (window.filePath || '/workspace').split('/').pop() || 'Files';

  return (
    <AppWindow
      key={window.id}
      id={window.id}
      title={folderName}
      icon={
        <div className="w-4 h-4 rounded flex items-center justify-center bg-gradient-to-br from-[#89A8C8] to-[#6B8DB5]">
          <Folder className="w-2.5 h-2.5 text-white" />
        </div>
      }
      isActive={isActive}
      initialPosition={window.position}
      initialSize={window.size}
      onFocus={onFocus}
      onClose={onClose}
      onMinimize={onMinimize}
      zIndex={window.zIndex}
    >
      <DesktopFolderBrowser folderPath={window.filePath} />
    </AppWindow>
  );
});

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
  messages?: any[];
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
  const [isSpotlightOpen, setIsSpotlightOpen] = useState(false);
  const [isCreatingNewFolder, setIsCreatingNewFolder] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const sandboxId = project?.sandbox?.id;
  const { data: workspaceFiles = [] } = useFileList('/workspace', {
    enabled: true,
  });
  const uploadMutation = useFileUpload();
  const mkdirMutation = useFileMkdir();
  const deleteMutation = useFileDelete();
  const renameMutation = useFileRename();

  const spotlightFiles = workspaceFiles.map(file => ({
    name: file.name,
    path: file.path || `/workspace/${file.name}`,
    type: file.type === 'directory' ? 'directory' as const : 'file' as const,
    extension: file.name.includes('.') ? file.name.split('.').pop() : undefined,
  }));

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setIsSpotlightOpen(true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const getInitialPosition = useCallback((index: number) => {
    const baseX = 20 + (index % 5) * 30;
    const baseY = 12 + (index % 5) * 30;
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

  const openSystemWindow = useCallback((type: 'files' | 'browser' | 'terminal') => {
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

      const windowSize = type === 'terminal' 
        ? { width: 800, height: 500 }
        : { width: 900, height: 600 };

      return [...prev, {
        id: windowId,
        type,
        zIndex: maxZIndex + 1,
        position: getInitialPosition(prev.length),
        size: windowSize,
        isMinimized: false,
      }];
    });
    
    setMaxZIndex(prev => prev + 1);
    setActiveWindowId(windowId);
    if (type !== 'terminal') {
      onViewChange(type);
    }
  }, [maxZIndex, getInitialPosition, onViewChange]);

  const openFileWindow = useCallback((path: string, isDirectory: boolean) => {
    const fileName = path.split('/').pop() || path;
    const windowId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    setOpenWindows(prev => [...prev, {
      id: windowId,
      type: isDirectory ? 'folder-browser' : 'file-viewer',
      filePath: path,
      fileName,
      zIndex: maxZIndex + 1,
      position: getInitialPosition(prev.length),
      size: isDirectory ? { width: 800, height: 500 } : { width: 700, height: 500 },
      isMinimized: false,
    }]);
    
    setMaxZIndex(prev => prev + 1);
    setActiveWindowId(windowId);
  }, [maxZIndex, getInitialPosition]);

  const openFileInfoWindow = useCallback((fileInfo: FileInfo) => {
    const windowId = `file-info-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    setOpenWindows(prev => [...prev, {
      id: windowId,
      type: 'file-info',
      fileInfo,
      fileName: fileInfo.name,
      filePath: fileInfo.path,
      zIndex: maxZIndex + 1,
      position: getInitialPosition(prev.length),
      size: { width: 380, height: 500 },
      isMinimized: false,
    }]);
    
    setMaxZIndex(prev => prev + 1);
    setActiveWindowId(windowId);
  }, [maxZIndex, getInitialPosition]);

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
  }, [toolCalls.length, openWindows.length, currentIndex, openToolWindow]);

  useEffect(() => {
    if (toolCalls.length > 0 && currentIndex >= 0 && currentIndex < toolCalls.length) {
      openToolWindow(currentIndex);
    }
  }, [currentIndex, toolCalls.length, openToolWindow]);

  useEffect(() => {
    if (toolCalls.length > 0 && latestIndex >= 0) {
      openToolWindow(latestIndex);
    }
  }, [latestIndex, toolCalls.length, openToolWindow]);

  // When activeView changes externally, open the corresponding window
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

  const handleOpenInfoWindow = useCallback(() => {
    const windowId = 'system-info';
    
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
        type: 'info' as const,
        zIndex: maxZIndex + 1,
        position: getInitialPosition(prev.length),
        size: { width: 400, height: 500 },
        isMinimized: false,
      }];
    });
    
    setMaxZIndex(prev => prev + 1);
    setActiveWindowId(windowId);
  }, [maxZIndex, getInitialPosition]);

  const handleOpenSpreadsheetWindow = useCallback(() => {
    const windowId = 'system-spreadsheet';
    
    setOpenWindows(prev => {
      const existing = prev.find(w => w.id === windowId);
      if (existing) {
        return prev.map(w => 
          w.id === windowId 
            ? { ...w, isMinimized: false, zIndex: maxZIndex + 1 } 
            : w
        );
      }
      
      return [...prev, {
        id: windowId,
        type: 'spreadsheet' as const,
        zIndex: maxZIndex + 1,
        position: getInitialPosition(prev.length),
        size: { width: 900, height: 650 },
        isMinimized: false,
      }];
    });
    
    setMaxZIndex(prev => prev + 1);
    setActiveWindowId(windowId);
  }, [maxZIndex, getInitialPosition]);

  const handleSystemAppClick = useCallback((type: 'files' | 'browser' | 'terminal' | 'info' | 'spreadsheet') => {
    if (type === 'info') {
      handleOpenInfoWindow();
    } else if (type === 'spreadsheet') {
      handleOpenSpreadsheetWindow();
    } else {
      openSystemWindow(type);
    }
  }, [openSystemWindow, handleOpenInfoWindow, handleOpenSpreadsheetWindow]);

  const isFilesWindowOpen = openWindows.some(w => w.id === 'system-files' && !w.isMinimized);
  const isBrowserWindowOpen = openWindows.some(w => w.id === 'system-browser' && !w.isMinimized);
  const isTerminalWindowOpen = openWindows.some(w => w.id === 'system-terminal' && !w.isMinimized);
  const isInfoWindowOpen = openWindows.some(w => w.id === 'system-info' && !w.isMinimized);
  const isSpreadsheetWindowOpen = openWindows.some(w => w.id === 'system-spreadsheet' && !w.isMinimized);

  const getActualSuccess = (toolCall: ToolCallInput): boolean => {
    if (toolCall?.toolResult?.success !== undefined) {
      return toolCall.toolResult.success;
    }
    return toolCall?.isSuccess ?? true;
  };

  const visibleWindows = openWindows.filter(w => !w.isMinimized);
  const isDesktopEmpty = visibleWindows.length === 0;

  const desktopFiles = workspaceFiles.map(file => ({
    name: file.name,
    path: file.path || `/workspace/${file.name}`,
    is_dir: file.type === 'directory',
    extension: file.name.includes('.') ? file.name.split('.').pop() : undefined,
    size: undefined as number | undefined,
    mod_time: undefined as string | undefined,
  }));

  const handleDesktopFileOpen = useCallback((path: string, isDirectory: boolean) => {
    openFileWindow(path, isDirectory);
  }, [openFileWindow]);

  const handleDesktopFileEdit = useCallback((path: string) => {
    openFileWindow(path, false);
  }, [openFileWindow]);

  const handleFileDownload = useCallback(async (filePath: string) => {
    const fileName = filePath.split('/').pop() || 'download';
    try {
      toast.loading(`Downloading ${fileName}...`, { id: 'download' });
      await downloadFile(filePath, fileName);
      toast.success(`Downloaded ${fileName}`, { id: 'download' });
    } catch (error) {
      console.error('Download failed:', error);
      toast.error(`Failed to download ${fileName}`, { id: 'download' });
    }
  }, []);

  const handleUploadFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      uploadMutation.mutate(
        { file, targetPath: '/workspace' },
        {
          onSuccess: () => {
            toast.success(`Uploaded ${file.name}`);
            queryClient.invalidateQueries({ queryKey: fileListKeys.all });
          },
          onError: (err) => {
            toast.error(`Failed to upload ${file.name}: ${err.message}`);
          },
        },
      );
    }
  }, [uploadMutation, queryClient]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleUploadFiles(e.target.files);
      e.target.value = '';
    }
  }, [handleUploadFiles]);

  const handleStartNewFolder = useCallback(() => {
    // Small delay to let context menu close first
    setTimeout(() => {
      setIsCreatingNewFolder(true);
    }, 50);
  }, []);

  const handleCreateNewFolder = useCallback(async (folderName: string) => {
    setIsCreatingNewFolder(false);
    
    if (workspaceFiles.some(f => f.name === folderName)) {
      toast.error(`"${folderName}" already exists`);
      return;
    }
    
    mkdirMutation.mutate(
      { dirPath: `/workspace/${folderName}` },
      {
        onSuccess: () => {
          toast.success(`Created folder "${folderName}"`);
          queryClient.invalidateQueries({ queryKey: fileListKeys.all });
        },
        onError: (err) => {
          toast.error(`Failed to create folder: ${err.message}`);
        },
      },
    );
  }, [workspaceFiles, mkdirMutation, queryClient]);

  const handleCancelNewFolder = useCallback(() => {
    setIsCreatingNewFolder(false);
  }, []);

  const handleFileDelete = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || filePath;
    deleteMutation.mutate(
      { filePath },
      {
        onSuccess: () => {
          toast.success(`Deleted "${fileName}"`);
          queryClient.invalidateQueries({ queryKey: fileListKeys.all });
        },
        onError: (err) => {
          toast.error(`Failed to delete "${fileName}": ${err.message}`);
        },
      },
    );
  }, [deleteMutation, queryClient]);

  const handleFileRename = useCallback((filePath: string) => {
    const oldName = filePath.split('/').pop() || '';
    const newName = window.prompt('Rename to:', oldName);
    if (!newName || newName === oldName) return;

    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    const newPath = `${parentDir}/${newName}`;

    renameMutation.mutate(
      { from: filePath, to: newPath },
      {
        onSuccess: () => {
          toast.success(`Renamed to "${newName}"`);
          queryClient.invalidateQueries({ queryKey: fileListKeys.all });
        },
        onError: (err) => {
          toast.error(`Failed to rename: ${err.message}`);
        },
      },
    );
  }, [renameMutation, queryClient]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleUploadFiles(e.dataTransfer.files);
    }
  }, [handleUploadFiles]);

  const handleDownloadAll = useCallback(async () => {
    if (!sandboxId) {
      toast.error('No sandbox available');
      return;
    }
    toast.info('Download all functionality coming soon');
  }, [sandboxId]);

  const renderDesktop = () => (
    <>
      <div className="absolute inset-0">
        {(desktopFiles.length > 0 || isCreatingNewFolder) && (
          <DesktopIcons 
            files={desktopFiles}
            onFileOpen={handleDesktopFileOpen}
            onFileEdit={handleDesktopFileEdit}
            onFileDownload={handleFileDownload}
            onFileDelete={handleFileDelete}
            onFileRename={handleFileRename}
            onGetFileInfo={(file) => openFileInfoWindow({
              name: file.name,
              path: file.path,
              isDirectory: file.is_dir,
              size: file.size,
              modTime: file.mod_time,
              extension: file.extension,
            })}
            isCreatingNewFolder={isCreatingNewFolder}
            onNewFolderCreate={handleCreateNewFolder}
            onNewFolderCancel={handleCancelNewFolder}
          />
        )}
        
        <AnimatePresence>
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

              if (window.type === 'terminal' && sandboxId) {
                return (
                  <AppWindow
                    key={window.id}
                    id={window.id}
                    title="Terminal"
                    icon={
                      <div className="w-4 h-4 rounded flex items-center justify-center bg-gradient-to-br from-[#3f3f46] to-[#18181b]">
                        <TerminalSquare className="w-2.5 h-2.5 text-[#4ade80]" />
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
                    <SSHTerminal sandboxId={sandboxId} />
                  </AppWindow>
                );
              }

              if (window.type === 'file-viewer' && window.filePath && sandboxId) {
                return (
                  <AppWindow
                    key={window.id}
                    id={window.id}
                    title={window.fileName || 'File'}
                    icon={
                      <div className="w-4 h-4 flex items-center justify-center">
                        {getFileIconByName(window.fileName || '', false)}
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
                    <DesktopFileViewer filePath={window.filePath} />
                  </AppWindow>
                );
              }

              if (window.type === 'folder-browser' && window.filePath && sandboxId) {
                return (
                  <FolderWindow
                    key={window.id}
                    window={window}
                    sandboxId={sandboxId}
                    isActive={activeWindowId === window.id}
                    onFocus={() => focusWindow(window.id)}
                    onClose={() => closeWindow(window.id)}
                    onMinimize={() => minimizeWindow(window.id)}
                  />
                );
              }

              if (window.type === 'info') {
                return (
                  <AppWindow
                    key={window.id}
                    id={window.id}
                    title="System Info"
                    icon={
                      <div className="w-4 h-4 rounded flex items-center justify-center bg-gradient-to-br from-[#64748B] to-[#475569]">
                        <Info className="w-2.5 h-2.5 text-white" />
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
                    <SystemInfoContent />
                  </AppWindow>
                );
              }
              if (window.type === 'file-info' && window.fileInfo) {
                return (
                  <AppWindow
                    key={window.id}
                    id={window.id}
                    title={`${window.fileInfo.name} Info`}
                    icon={
                      <div className="w-4 h-4 flex items-center justify-center">
                        {getFileIconByName(window.fileInfo.name, window.fileInfo.isDirectory)}
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
                    <FileInfoContent fileInfo={window.fileInfo} />
                  </AppWindow>
                );
              }

              if (window.type === 'spreadsheet') {
                return (
                  <AppWindow
                    key={window.id}
                    id={window.id}
                    title="Spreadsheets"
                    icon={
                      <div className="w-4 h-4 rounded flex items-center justify-center bg-gradient-to-br from-[#10b981] to-[#059669]">
                        <Table className="w-2.5 h-2.5 text-white" />
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
                    <SpreadsheetApp
                      sandboxId={sandboxId}
                      initialFilePath={window.filePath}
                    />
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
        showFilesTab={false}
        isFilesWindowOpen={isFilesWindowOpen}
        isBrowserWindowOpen={isBrowserWindowOpen}
        isTerminalWindowOpen={isTerminalWindowOpen}
        isInfoWindowOpen={isInfoWindowOpen}
        isSpreadsheetWindowOpen={isSpreadsheetWindowOpen}
      />
    </>
  );

  return (
    <DesktopContextMenu
      onRefresh={() => {
        queryClient.invalidateQueries({ queryKey: fileListKeys.all });
        toast.success('Refreshed');
      }}
      onOpenFiles={() => handleSystemAppClick('files')}
      onOpenBrowser={() => handleSystemAppClick('browser')}
      onOpenTerminal={() => handleSystemAppClick('terminal')}
      onNewFolder={handleStartNewFolder}
      onUpload={() => fileInputRef.current?.click()}
      onDownloadAll={handleDownloadAll}
      onShowInfo={handleOpenInfoWindow}
    >
      <div 
        className="relative w-full h-full overflow-hidden flex flex-col"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />
        
        <div className="absolute inset-0">
          <div className="absolute inset-0 dark:block hidden">
            <Image 
              src="https://heprlhlltebrxydgtsjs.supabase.co/storage/v1/object/public/image-uploads/backgrounds/computer-bg-dark.jpg"
              alt="Desktop wallpaper"
              fill
              className="object-cover"
              unoptimized
            />
          </div>
          <div className="absolute inset-0 dark:hidden">
            <Image 
              src="https://heprlhlltebrxydgtsjs.supabase.co/storage/v1/object/public/image-uploads/backgrounds/computer-bg-light.jpg"
              alt="Desktop wallpaper"
              fill
              className="object-cover"
              unoptimized
            />
          </div>
          <div className="absolute inset-0 bg-black/10" />
        </div>

        <div className="relative z-50 flex-shrink-0">
          <PanelHeader
            onClose={onClose}
            onMaximize={onClose}
            isStreaming={isStreaming}
            variant="motion"
            currentView={currentView}
            onViewChange={onViewChange}
            showFilesTab={false}
            isMaximized={true}
          />
        </div>

        <div className="relative flex-1 overflow-hidden">
          {renderDesktop()}
        </div>

        <QuickLaunch
          isOpen={isSpotlightOpen}
          onClose={() => setIsSpotlightOpen(false)}
          onOpenFiles={() => handleSystemAppClick('files')}
          onOpenBrowser={() => handleSystemAppClick('browser')}
          onOpenTerminal={() => handleSystemAppClick('terminal')}
          onOpenSystemInfo={() => handleSystemAppClick('info')}
          onOpenSpreadsheets={() => handleSystemAppClick('spreadsheet')}
          onFileSelect={(path) => {
            const isDir = spotlightFiles.find(f => f.path === path)?.type === 'directory';
            openFileWindow(path, isDir);
            setIsSpotlightOpen(false);
          }}
          files={spotlightFiles}
        />
      </div>
    </DesktopContextMenu>
  );
});

SandboxDesktop.displayName = 'SandboxDesktop';
