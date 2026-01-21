'use client';

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { getFileIcon, FolderIcon } from './Icons';
import { FileContextMenu } from './FileContextMenu';
import { ContextMenuTrigger } from '@/components/ui/context-menu';
import { toast } from '@/lib/toast';

interface DesktopFile {
  name: string;
  path: string;
  is_dir: boolean;
  extension?: string;
  size?: number;
  mod_time?: string;
}

interface DesktopIconsProps {
  files: DesktopFile[];
  onFileOpen?: (path: string, isDirectory: boolean) => void;
  onFileEdit?: (path: string) => void;
  onFileDownload?: (path: string) => void;
  onFileDelete?: (path: string) => void;
  onGetFileInfo?: (file: DesktopFile) => void;
  isCreatingNewFolder?: boolean;
  onNewFolderCreate?: (name: string) => void;
  onNewFolderCancel?: () => void;
}

function getNextFolderName(files: DesktopFile[]): string {
  const existingNames = new Set(files.filter(f => f.is_dir).map(f => f.name.toLowerCase()));
  
  if (!existingNames.has('new folder')) {
    return 'New Folder';
  }
  
  let counter = 2;
  while (existingNames.has(`new folder ${counter}`)) {
    counter++;
  }
  return `New Folder ${counter}`;
}

export const DesktopIcons = memo(function DesktopIcons({
  files,
  onFileOpen,
  onFileEdit,
  onFileDownload,
  onFileDelete,
  onGetFileInfo,
  isCreatingNewFolder,
  onNewFolderCreate,
  onNewFolderCancel,
}: DesktopIconsProps) {
  const [activeContextPath, setActiveContextPath] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('New Folder');
  const inputRef = useRef<HTMLInputElement>(null);
  const wasCreatingRef = useRef(false);

  useEffect(() => {
    // Only run when transitioning from false to true
    if (isCreatingNewFolder && !wasCreatingRef.current) {
      const suggestedName = getNextFolderName(files);
      setNewFolderName(suggestedName);
      
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 150);
      
      wasCreatingRef.current = true;
      return () => clearTimeout(timer);
    } else if (!isCreatingNewFolder) {
      wasCreatingRef.current = false;
    }
  }, [isCreatingNewFolder, files]);

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path);
    toast.success('Path copied to clipboard');
  }, []);

  const handleNewFolderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmedName = newFolderName.trim();
      if (trimmedName) {
        onNewFolderCreate?.(trimmedName);
      } else {
        onNewFolderCancel?.();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onNewFolderCancel?.();
    }
  }, [newFolderName, onNewFolderCreate, onNewFolderCancel]);


  return (
    <div className="absolute right-2 top-0 bottom-20 pointer-events-none overflow-visible px-2">
      <div 
        className="flex flex-col flex-wrap-reverse gap-0.5 h-full content-start items-start justify-start"
      >
        {isCreatingNewFolder && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className={cn(
              "flex flex-col items-center justify-start gap-1.5 p-2 rounded-xl pointer-events-auto w-[84px]",
              "bg-white/20 ring-2 ring-white/30 backdrop-blur-sm"
            )}
          >
            <div className="w-[52px] h-[52px] flex items-center justify-center shrink-0 drop-shadow-md">
              <FolderIcon />
            </div>
            <input
              ref={inputRef}
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={handleNewFolderKeyDown}
              className="text-[11px] font-medium text-white text-center w-full leading-tight bg-black/40 rounded px-1 py-0.5 outline-none border border-white/30 focus:border-white/60"
              style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
            />
          </motion.div>
        )}
        {files.map((file) => (
          <FileContextMenu
            key={file.path}
            fileName={file.name}
            filePath={file.path}
            isDirectory={file.is_dir}
            onOpen={() => onFileOpen?.(file.path, file.is_dir)}
            onEdit={() => onFileEdit?.(file.path)}
            onDownload={() => onFileDownload?.(file.path)}
            onDelete={() => onFileDelete?.(file.path)}
            onCopyPath={() => handleCopyPath(file.path)}
            onGetInfo={() => onGetFileInfo?.(file)}
            onOpenChange={(open) => setActiveContextPath(open ? file.path : null)}
          >
            <ContextMenuTrigger asChild>
              <motion.button
                initial={{ opacity: 0, scale: 1, y: 0 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ delay: 0.05, type: 'spring', stiffness: 500, damping: 30 }}
                onDoubleClick={() => onFileOpen?.(file.path, file.is_dir)}
                className={cn(
                  "flex flex-col items-center justify-start gap-1.5 p-2 rounded-xl pointer-events-auto w-[84px]",
                  "hover:bg-white/10 active:bg-white/20 backdrop-blur-sm",
                  "transition-all duration-100 cursor-default select-none group",
                  activeContextPath === file.path && "bg-white/20 ring-2 ring-white/30"
                )}
                drag
                dragMomentum={false}
                dragElastic={0}
                whileTap={{ scale: 0.96 }}
                whileDrag={{ scale: 1.1, zIndex: 1000 }}
              >
                <div className="w-[52px] h-[52px] flex items-center justify-center transition-transform duration-100 shrink-0 drop-shadow-md group-hover:drop-shadow-lg">
                  {getFileIcon(file)}
                </div>
                <span className="text-[11px] font-medium text-white text-center w-full leading-tight break-words drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
                  {file.name}
                </span>
              </motion.button>
            </ContextMenuTrigger>
          </FileContextMenu>
        ))}
      </div>
    </div>
  );
});

DesktopIcons.displayName = 'DesktopIcons';
