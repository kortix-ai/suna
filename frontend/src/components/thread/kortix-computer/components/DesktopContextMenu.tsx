'use client';

import { memo } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import { 
  RefreshCw, 
  FolderPlus, 
  Upload, 
  Download,
  Info,
  Folder,
  Globe,
  TerminalSquare,
} from 'lucide-react';

interface DesktopContextMenuProps {
  children: React.ReactNode;
  onRefresh?: () => void;
  onNewFolder?: () => void;
  onUpload?: () => void;
  onDownloadAll?: () => void;
  onOpenFiles?: () => void;
  onOpenBrowser?: () => void;
  onOpenTerminal?: () => void;
  onShowInfo?: () => void;
}

export const DesktopContextMenu = memo(function DesktopContextMenu({
  children,
  onRefresh,
  onNewFolder,
  onUpload,
  onDownloadAll,
  onOpenFiles,
  onOpenBrowser,
  onOpenTerminal,
  onShowInfo,
}: DesktopContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56 bg-background/40 backdrop-blur-xl border-border/20 rounded-xl overflow-hidden">
        <ContextMenuItem 
          onClick={onOpenFiles}
          className="focus:bg-accent rounded-lg"
        >
          <Folder className="h-4 w-4" />
          Open Files
        </ContextMenuItem>
        <ContextMenuItem 
          onClick={onOpenBrowser}
          className="focus:bg-accent rounded-lg"
        >
          <Globe className="h-4 w-4" />
          Open Browser
        </ContextMenuItem>
        <ContextMenuItem 
          onClick={onOpenTerminal}
          className="focus:bg-accent rounded-lg"
        >
          <TerminalSquare className="h-4 w-4" />
          Open Terminal
        </ContextMenuItem>
        
        <ContextMenuSeparator className="bg-border" />
        
        <ContextMenuItem 
          onClick={onRefresh}
          className="focus:bg-accent rounded-lg"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
          <ContextMenuShortcut>⌘R</ContextMenuShortcut>
        </ContextMenuItem>
        
        <ContextMenuSeparator className="bg-border" />
        
        <ContextMenuItem 
          onClick={onNewFolder}
          className="focus:bg-accent rounded-lg"
        >
          <FolderPlus className="h-4 w-4" />
          New Folder
          <ContextMenuShortcut>⇧⌘N</ContextMenuShortcut>
        </ContextMenuItem>
        
        <ContextMenuItem 
          onClick={onUpload}
          className="focus:bg-accent rounded-lg"
        >
          <Upload className="h-4 w-4" />
          Upload Files
        </ContextMenuItem>
        
        <ContextMenuItem 
          onClick={onDownloadAll}
          className="focus:bg-accent rounded-lg"
        >
          <Download className="h-4 w-4" />
          Download All
        </ContextMenuItem>
        
        <ContextMenuSeparator className="bg-border" />
    
        <ContextMenuItem 
          onClick={onShowInfo}
          className="focus:bg-accent rounded-lg"
        >
          <Info className="h-4 w-4" />
          Get Info
          <ContextMenuShortcut>⌘I</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

DesktopContextMenu.displayName = 'DesktopContextMenu';
