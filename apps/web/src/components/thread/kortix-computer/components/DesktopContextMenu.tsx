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
  FilePlus,
  Upload, 
  Download,
  Info,
  Folder,
  Globe,
  TerminalSquare,
  Clipboard,
} from 'lucide-react';
import { useFilesStore } from '@/features/files/store/files-store';

interface DesktopContextMenuProps {
  children: React.ReactNode;
  onRefresh?: () => void;
  onNewFolder?: () => void;
  onNewFile?: () => void;
  onUpload?: () => void;
  onDownloadAll?: () => void;
  onOpenFiles?: () => void;
  onOpenBrowser?: () => void;
  onOpenTerminal?: () => void;
  onShowInfo?: () => void;
  onPaste?: () => void;
}

export const DesktopContextMenu = memo(function DesktopContextMenu({
  children,
  onRefresh,
  onNewFolder,
  onNewFile,
  onUpload,
  onDownloadAll,
  onOpenFiles,
  onOpenBrowser,
  onOpenTerminal,
  onShowInfo,
  onPaste,
}: DesktopContextMenuProps) {
  const clipboard = useFilesStore((s) => s.clipboard);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56 bg-background/60 backdrop-blur-xl border-border/20 rounded-2xl overflow-hidden">
        <ContextMenuItem 
          onClick={onOpenFiles}
          className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg gap-2"
        >
          <Folder className="h-4 w-4" />
          Open Files
        </ContextMenuItem>
        <ContextMenuItem 
          onClick={onOpenBrowser}
          className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg gap-2"
        >
          <Globe className="h-4 w-4" />
          Open Browser
        </ContextMenuItem>
        <ContextMenuItem 
          onClick={onOpenTerminal}
          className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg gap-2"
        >
          <TerminalSquare className="h-4 w-4" />
          Open Terminal
        </ContextMenuItem>
        
        <ContextMenuSeparator className="bg-border/50" />

        {onNewFile && (
          <ContextMenuItem 
            onClick={onNewFile}
            className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg gap-2"
          >
            <FilePlus className="h-4 w-4" />
            New File
          </ContextMenuItem>
        )}
        
        <ContextMenuItem 
          onClick={onNewFolder}
          className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg gap-2"
        >
          <FolderPlus className="h-4 w-4" />
          New Folder
          <ContextMenuShortcut>⇧⌘N</ContextMenuShortcut>
        </ContextMenuItem>

        {clipboard && onPaste && (
          <>
            <ContextMenuSeparator className="bg-border/50" />
            <ContextMenuItem 
              onClick={onPaste}
              className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg gap-2"
            >
              <Clipboard className="h-4 w-4" />
              Paste ({clipboard.operation === 'cut' ? 'Move' : 'Copy'})
              <ContextMenuShortcut>⌘V</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
        
        <ContextMenuSeparator className="bg-border/50" />
    
        <ContextMenuItem 
          onClick={onShowInfo}
          className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg gap-2"
        >
          <Info className="h-4 w-4" />
          System Info
          <ContextMenuShortcut>⌘I</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

DesktopContextMenu.displayName = 'DesktopContextMenu';
