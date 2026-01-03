'use client';

import { memo, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Folder, Globe, TerminalSquare, Info, Table } from 'lucide-react';
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
import { useDirectoryQuery, fetchFileContent, fileQueryKeys } from '@/hooks/files/use-file-queries';
import { useFileUpload } from '@/hooks/files/use-file-mutations';
import { DesktopContextMenu } from './DesktopContextMenu';
import { QuickLaunch } from './QuickLaunch';
import { DesktopIcons } from './DesktopIcons';
import { SSHTerminal } from './SSHTerminal';
import { FileViewerView } from '../FileViewerView';
import { EnhancedFileBrowser } from './EnhancedFileBrowser';
import { getFileIconByName } from './Icons';
import { SystemInfoContent } from './SystemInfoContent';
import { FileInfoContent, FileInfo } from './FileInfoContent';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';

// Lazy load SpreadsheetApp as it imports Syncfusion (~1-2 MB)
const SpreadsheetApp = dynamic(
  () => import('./SpreadsheetApp').then((mod) => mod.SpreadsheetApp),
  { ssr: false, loading: () => <div className="flex items-center justify-center h-full text-muted-foreground">Loading spreadsheet...</div> }
);
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/AuthProvider';

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
  onOpenFile: (path: string, isDir: boolean) => void;
  onGetFileInfo: (fileInfo: FileInfo) => void;
  onFileDownload: (path: string) => void;
}

const FolderWindow = memo(function FolderWindow({
  window,
  sandboxId,
  isActive,
  onFocus,
  onClose,
  onMinimize,
  onOpenFile,
  onGetFileInfo,
  onFileDownload,
}: FolderWindowProps) {
  const [currentPath, setCurrentPath] = useState(window.filePath || '/workspace');
  const { data: files = [] } = useDirectoryQuery(sandboxId, currentPath, { enabled: !!sandboxId });

  const folderFiles = files.map(f => ({
    name: f.name,
    path: f.path || `${currentPath}/${f.name}`,
    is_dir: f.is_dir,
    size: f.size || 0,
    mod_time: f.mod_time || '',
  }));

  const pathSegments = currentPath.split('/').filter(Boolean);
  const parentPath = pathSegments.length > 1 
    ? '/' + pathSegments.slice(0, -1).join('/') 
    : '/workspace';

  const folderName = currentPath.split('/').pop() || 'Folder';

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
      <EnhancedFileBrowser
        files={folderFiles}
        currentPath={currentPath}
        onNavigate={setCurrentPath}
        onFileOpen={(path) => {
          const file = folderFiles.find(f => f.path === path);
          if (file) {
            onOpenFile(path, file.is_dir);
          }
        }}
        onFileDownload={onFileDownload}
        onGetFileInfo={(file) => onGetFileInfo({
          name: file.name,
          path: file.path,
          isDirectory: file.is_dir,
          size: file.size,
          modTime: file.mod_time,
        })}
        onBack={() => setCurrentPath(parentPath)}
        sandboxId={sandboxId}
      />
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
  const [isSpotlightOpen, setIsSpotlightOpen] = useState(false);
  const [sandboxInfoOpen, setSandboxInfoOpen] = useState(false);
  const [isCreatingNewFolder, setIsCreatingNewFolder] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const fileUploadMutation = useFileUpload();
  const { session } = useAuth();

  const { data: sandboxDetails, isLoading: sandboxLoading, error: sandboxError } = useSandboxDetails(project_id);
  
  const sandboxId = project?.sandbox?.id;
  const { data: workspaceFiles = [] } = useDirectoryQuery(sandboxId, '/workspace', {
    enabled: !!sandboxId,
    staleTime: 30000,
  });

  const spotlightFiles = workspaceFiles.map(file => ({
    name: file.name,
    path: file.path || `/workspace/${file.name}`,
    type: file.is_dir ? 'directory' as const : 'file' as const,
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
    is_dir: file.is_dir,
    extension: file.name.includes('.') ? file.name.split('.').pop() : undefined,
    size: file.size,
    mod_time: file.mod_time,
  }));

  const handleDesktopFileOpen = useCallback((path: string, isDirectory: boolean) => {
    openFileWindow(path, isDirectory);
  }, [openFileWindow]);

  const handleDesktopFileEdit = useCallback((path: string) => {
    openFileWindow(path, false);
  }, [openFileWindow]);

  const handleFileDownload = useCallback(async (filePath: string) => {
    if (!sandboxId || !session?.access_token) {
      toast.error('Cannot download file');
      return;
    }

    const fileName = filePath.split('/').pop() || 'download';
    
    try {
      toast.loading(`Downloading ${fileName}...`, { id: 'download' });
      
      const blob = await fetchFileContent(sandboxId, filePath, 'blob', session.access_token);
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success(`Downloaded ${fileName}`, { id: 'download' });
    } catch (error) {
      console.error('Download failed:', error);
      toast.error(`Failed to download ${fileName}`, { id: 'download' });
    }
  }, [sandboxId, session?.access_token]);

  const handleUploadFiles = useCallback((files: FileList | File[]) => {
    if (!sandboxId) {
      toast.error('No sandbox available');
      return;
    }
    
    const fileArray = Array.from(files);
    fileArray.forEach(file => {
      const targetPath = `/workspace/${file.name}`;
      fileUploadMutation.mutate({
        sandboxId,
        file,
        targetPath,
      });
    });
  }, [sandboxId, fileUploadMutation]);

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
    
    if (!sandboxId || !session?.access_token) {
      toast.error('Cannot create folder');
      return;
    }
    
    if (workspaceFiles.some(f => f.name === folderName)) {
      toast.error(`"${folderName}" already exists`);
      return;
    }
    
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/terminal/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          command: `mkdir -p "/workspace/${folderName}"`,
        }),
      });
      
      if (response.ok) {
        toast.success(`Created "${folderName}"`);
        queryClient.invalidateQueries({ queryKey: fileQueryKeys.directories() });
      } else {
        toast.error('Failed to create folder');
      }
    } catch (error) {
      toast.error('Failed to create folder');
    }
  }, [sandboxId, session?.access_token, workspaceFiles, queryClient]);

  const handleCancelNewFolder = useCallback(() => {
    setIsCreatingNewFolder(false);
  }, []);

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
        {!sandboxInfoOpen && (desktopFiles.length > 0 || isCreatingNewFolder) && (
          <DesktopIcons 
            files={desktopFiles}
            onFileOpen={handleDesktopFileOpen}
            onFileEdit={handleDesktopFileEdit}
            onFileDownload={handleFileDownload}
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
          {sandboxInfoOpen && (
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
                    <FileViewerView
                      sandboxId={sandboxId}
                      filePath={window.filePath}
                      project={project}
                      projectId={project_id}
                    />
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
                    onOpenFile={(path, isDir) => openFileWindow(path, isDir)}
                    onGetFileInfo={(fileInfo) => openFileInfoWindow(fileInfo)}
                    onFileDownload={handleFileDownload}
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
                    <SystemInfoContent
                      sandboxDetails={sandboxDetails}
                      isLoading={sandboxLoading}
                    />
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
        showFilesTab={true}
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
        queryClient.invalidateQueries({ queryKey: fileQueryKeys.directories() });
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
            onMaximize={onClose}
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
