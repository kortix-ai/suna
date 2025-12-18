'use client';

import { memo } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import { 
  RefreshCw, 
  FolderPlus, 
  Upload, 
  Download,
  Grid3X3,
  List,
  SortAsc,
  SortDesc,
  Calendar,
  FileText,
  HardDrive,
  Info,
  Folder,
  Globe,
} from 'lucide-react';

interface DesktopContextMenuProps {
  children: React.ReactNode;
  onRefresh?: () => void;
  onNewFolder?: () => void;
  onUpload?: () => void;
  onDownloadAll?: () => void;
  onOpenFiles?: () => void;
  onOpenBrowser?: () => void;
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

