'use client';

import { memo, useState, useCallback } from 'react';
import { 
  Folder, 
  ChevronRight,
  Home,
  HardDrive,
  ChevronLeft,
  Search,
  Grid3X3,
  List,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { getFileIconByName } from './Icons';
import { FileContextMenu } from './FileContextMenu';
import { ContextMenuTrigger } from '@/components/ui/context-menu';
import { toast } from '@/lib/toast';

interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mod_time: string;
}

interface EnhancedFileBrowserProps {
  files: FileItem[];
  currentPath: string;
  onNavigate?: (path: string) => void;
  onFileOpen?: (path: string) => void;
  onFileEdit?: (path: string) => void;
  onFileDownload?: (path: string) => void;
  onFileDelete?: (path: string) => void;
  onGetFileInfo?: (file: FileItem) => void;
  onBack?: () => void;
  sandboxId?: string;
}

const SidebarItem = memo(function SidebarItem({
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  icon: any;
  label: string;
  isActive?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors",
        isActive
          ? "bg-accent/80 text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
});

SidebarItem.displayName = 'SidebarItem';

export const EnhancedFileBrowser = memo(function EnhancedFileBrowser({
  files,
  currentPath,
  onNavigate,
  onFileOpen,
  onFileEdit,
  onFileDownload,
  onFileDelete,
  onGetFileInfo,
  onBack,
}: EnhancedFileBrowserProps) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeContextPath, setActiveContextPath] = useState<string | null>(null);

  const filteredFiles = searchQuery
    ? files.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : files;

  const pathSegments = currentPath.split('/').filter(Boolean);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return dateString;
    }
  };

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path);
    toast.success('Path copied to clipboard');
  }, []);

  const handleFileAction = useCallback((file: FileItem) => {
    if (file.is_dir) {
      onNavigate?.(file.path);
    } else {
      onFileOpen?.(file.path);
    }
  }, [onNavigate, onFileOpen]);

  return (
    <div className="flex h-full bg-background/70 backdrop-blur-2xl">
      <div className="w-56 p-2 flex flex-col">
        <div className="flex flex-col rounded-xl bg-background/70 border border-border h-full">
          <div className="p-3 space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 py-1">
              Favorites
            </div>
            <SidebarItem
              icon={Home}
              label="workspace"
              isActive={currentPath === '/workspace'}
              onClick={() => onNavigate?.('/workspace')}
            />
          </div>
          
          <div className="flex-1 overflow-auto px-3">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 py-1 mt-4">
              Locations
            </div>
            <div className="space-y-1 mt-2">
              <SidebarItem
                icon={HardDrive}
                label="workspace"
                isActive={currentPath === '/workspace'}
                onClick={() => onNavigate?.('/workspace')}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-12 flex items-center justify-between px-4 gap-4">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={onBack}
              disabled={currentPath === '/workspace'}
              className={cn(
                "p-1.5 rounded-lg transition-colors",
                currentPath === '/workspace'
                  ? "text-muted-foreground cursor-not-allowed"
                  : "hover:bg-accent/80 text-foreground"
              )}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            
            <div className="flex items-center gap-1 text-sm text-muted-foreground min-w-0 flex-1 overflow-x-auto">
              {pathSegments.map((segment, index) => (
                <div key={index} className="flex items-center gap-1 shrink-0">
                  {index > 0 && <ChevronRight className="h-3 w-3" />}
                  <button
                    onClick={() => {
                      const path = '/' + pathSegments.slice(0, index + 1).join('/');
                      onNavigate?.(path);
                    }}
                    className="hover:text-foreground transition-colors"
                  >
                    {segment}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 pr-3 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring w-48"
              />
            </div>
            
            <div className="flex items-center border border-border rounded-lg">
              <button
                onClick={() => setViewMode('grid')}
                className={cn(
                  "p-1.5 transition-colors rounded-l-lg",
                  viewMode === 'grid' ? "bg-accent/80" : "hover:bg-accent/50"
                )}
              >
                <Grid3X3 className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={cn(
                  "p-1.5 transition-colors rounded-r-lg border-l border-border",
                  viewMode === 'list' ? "bg-accent/80" : "hover:bg-accent/50"
                )}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-4">
              {filteredFiles.map((file, index) => (
                <FileContextMenu
                  key={file.path}
                  fileName={file.name}
                  filePath={file.path}
                  isDirectory={file.is_dir}
                  onOpen={() => handleFileAction(file)}
                  onEdit={() => onFileEdit?.(file.path)}
                  onDownload={() => onFileDownload?.(file.path)}
                  onDelete={() => onFileDelete?.(file.path)}
                  onCopyPath={() => handleCopyPath(file.path)}
                  onGetInfo={() => onGetFileInfo?.(file)}
                  onOpenChange={(open) => setActiveContextPath(open ? file.path : null)}
                >
                  <ContextMenuTrigger asChild>
                    <motion.button
                      initial={{ opacity: 0, y: 0 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 }}
                      onDoubleClick={() => handleFileAction(file)}
                      className={cn(
                        "flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-accent/60 transition-all text-left group",
                        activeContextPath === file.path && "bg-accent/80 ring-2 ring-primary/30"
                      )}
                    >
                      <div className="w-14 h-14 flex items-center justify-center group-hover:scale-105 transition-transform drop-shadow-sm">
                        {getFileIconByName(file.name, file.is_dir)}
                      </div>
                      <span className="text-xs text-center line-clamp-2 w-full font-medium">{file.name}</span>
                    </motion.button>
                  </ContextMenuTrigger>
                </FileContextMenu>
              ))}
            </div>
          ) : (
            <div className="space-y-0.5">
              <div className="flex items-center gap-4 px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border">
                <div className="flex-1">Name</div>
                <div className="w-24 text-right">Size</div>
                <div className="w-32">Modified</div>
              </div>
              {filteredFiles.map((file, index) => (
                <FileContextMenu
                  key={file.path}
                  fileName={file.name}
                  filePath={file.path}
                  isDirectory={file.is_dir}
                  onOpen={() => handleFileAction(file)}
                  onEdit={() => onFileEdit?.(file.path)}
                  onDownload={() => onFileDownload?.(file.path)}
                  onDelete={() => onFileDelete?.(file.path)}
                  onCopyPath={() => handleCopyPath(file.path)}
                  onGetInfo={() => onGetFileInfo?.(file)}
                  onOpenChange={(open) => setActiveContextPath(open ? file.path : null)}
                >
                  <ContextMenuTrigger asChild>
                    <motion.button
                      initial={{ opacity: 0, x: 0 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.05 }}
                      onDoubleClick={() => handleFileAction(file)}
                      className={cn(
                        "flex items-center gap-4 px-3 py-2 rounded-lg hover:bg-accent/60 transition-all text-left w-full",
                        activeContextPath === file.path && "bg-accent/80 ring-2 ring-primary/30"
                      )}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className="w-5 h-5 shrink-0">
                          {getFileIconByName(file.name, file.is_dir)}
                        </div>
                        <span className="text-sm truncate">{file.name}</span>
                      </div>
                      <div className="w-24 text-right text-sm text-muted-foreground">
                        {file.is_dir ? '--' : formatFileSize(file.size)}
                      </div>
                      <div className="w-32 text-sm text-muted-foreground">
                        {formatDate(file.mod_time)}
                      </div>
                    </motion.button>
                  </ContextMenuTrigger>
                </FileContextMenu>
              ))}
            </div>
          )}
          
          {filteredFiles.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Folder className="h-16 w-16 mb-4 opacity-50" />
              <p className="text-sm">
                {searchQuery ? `No files matching "${searchQuery}"` : 'This folder is empty'}
              </p>
            </div>
          )}
        </div>

        <div className="h-12 flex items-center justify-between px-4 text-xs text-muted-foreground">
          <span>{filteredFiles.length} {filteredFiles.length === 1 ? 'item' : 'items'}</span>
          <span>{currentPath}</span>
        </div>
      </div>
    </div>
  );
});

EnhancedFileBrowser.displayName = 'EnhancedFileBrowser';
