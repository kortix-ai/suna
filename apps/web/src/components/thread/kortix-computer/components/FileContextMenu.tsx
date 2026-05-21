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
  ClipboardCopy,
  Scissors,
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
  onCopy?: () => void;
  onCut?: () => void;
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
  onCopy,
  onCut,
  onGetInfo,
  onOpenChange,
}: FileContextMenuProps) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      {children}
      <ContextMenuContent className="w-52 bg-background/60 backdrop-blur-2xl border-border/20 rounded-2xl overflow-hidden shadow-2xl">
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

        <ContextMenuSeparator />

        {onCopy && (
          <ContextMenuItem 
            onClick={onCopy}
            className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg"
          >
            <ClipboardCopy className="h-4 w-4 text-muted-foreground" />
            Copy
            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
          </ContextMenuItem>
        )}

        {onCut && (
          <ContextMenuItem 
            onClick={onCut}
            className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg"
          >
            <Scissors className="h-4 w-4 text-muted-foreground" />
            Cut
            <ContextMenuShortcut>⌘X</ContextMenuShortcut>
          </ContextMenuItem>
        )}

        {onCopyPath && (
          <ContextMenuItem 
            onClick={onCopyPath}
            className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg"
          >
            <Copy className="h-4 w-4 text-muted-foreground" />
            Copy Path
          </ContextMenuItem>
        )}

        {(onEdit || onDelete) && <ContextMenuSeparator />}

        {onEdit && (
          <ContextMenuItem 
            onClick={onEdit}
            className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg"
          >
            <Pencil className="h-4 w-4 text-muted-foreground" />
            Rename
          </ContextMenuItem>
        )}

        {onDelete && (
          <ContextMenuItem 
            onClick={onDelete}
            className="focus:bg-background/10 focus:backdrop-blur-xl rounded-lg text-destructive focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete
            <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
          </ContextMenuItem>
        )}

      </ContextMenuContent>
    </ContextMenu>
  );
});

FileContextMenu.displayName = 'FileContextMenu';
