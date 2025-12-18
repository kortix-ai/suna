'use client';

import { memo, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { getFileIcon } from './Icons';
import { FileContextMenu } from './FileContextMenu';
import { ContextMenuTrigger } from '@/components/ui/context-menu';
import { toast } from 'sonner';

interface DesktopFile {
  name: string;
  path: string;
  is_dir: boolean;
  extension?: string;
}

interface DesktopIconsProps {
  files: DesktopFile[];
  onFileOpen?: (path: string, isDirectory: boolean) => void;
  onFileEdit?: (path: string) => void;
  onFileDownload?: (path: string) => void;
  onFileDelete?: (path: string) => void;
}

export const DesktopIcons = memo(function DesktopIcons({
  files,
  onFileOpen,
  onFileEdit,
  onFileDownload,
  onFileDelete,
}: DesktopIconsProps) {
  const [activeContextPath, setActiveContextPath] = useState<string | null>(null);

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path);
    toast.success('Path copied to clipboard');
  }, []);

  return (
    <div className="absolute right-2 -top-12 bottom-20 pointer-events-none overflow-visible px-2">
      <div 
        className="flex flex-col flex-wrap-reverse gap-0.5 h-full content-start items-start justify-start"
      >
        {files.map((file, index) => (
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
            onGetInfo={() => toast.info(`${file.name}\n${file.path}`)}
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
                whileHover={{ scale: 1.04 }}
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
