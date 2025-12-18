'use client';

import { memo } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import { 
  Eye, 
  Pencil, 
  Download, 
  Trash2,
  Copy,
  Info,
  FolderOpen,
} from 'lucide-react';

interface FileContextMenuProps {
  children: React.ReactNode;
  fileName: string;
  filePath: string;
  isDirectory: boolean;
  onOpen?: () => void;
  onEdit?: () => void;
  onDownload?: () => void;
  onDelete?: () => void;
  onCopyPath?: () => void;
  onGetInfo?: () => void;
  onOpenChange?: (open: boolean) => void;
}

export const FileContextMenu = memo(function FileContextMenu({
  children,
  isDirectory,
  onOpen,
  onEdit,
  onDownload,
  onDelete,
  onCopyPath,
  onGetInfo,
  onOpenChange,
}: FileContextMenuProps) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      {children}
      <ContextMenuContent className="w-52 bg-background/60 backdrop-blur-2xl border-border/20 rounded-xl overflow-hidden shadow-2xl">
        <ContextMenuItem 
          onClick={onOpen}
          className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg"
        >
          {isDirectory ? (
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Eye className="h-4 w-4 text-muted-foreground" />
          )}
          {isDirectory ? 'Open' : 'Quick Look'}
          <ContextMenuShortcut>Space</ContextMenuShortcut>
        </ContextMenuItem>

        {!isDirectory && (
          <ContextMenuItem 
            onClick={onDownload}
            className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg"
          >
            <Download className="h-4 w-4 text-muted-foreground" />
            Download
            <ContextMenuShortcut>⌘D</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        
        <ContextMenuItem 
          onClick={onGetInfo}
          className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg"
        >
          <Info className="h-4 w-4 text-muted-foreground" />
          Get Info
          <ContextMenuShortcut>⌘I</ContextMenuShortcut>
        </ContextMenuItem>

      </ContextMenuContent>
    </ContextMenu>
  );
});

FileContextMenu.displayName = 'FileContextMenu';
