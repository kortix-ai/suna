'use client';

import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Search, 
  File, 
  Folder, 
  FileText, 
  FileCode, 
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  Globe,
  Terminal,
  ArrowRight,
  Command,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

interface FileResult {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
}

interface SpotlightSearchProps {
  isOpen: boolean;
  onClose: () => void;
  onFileSelect?: (path: string) => void;
  onOpenFiles?: () => void;
  onOpenBrowser?: () => void;
  files?: FileResult[];
}

const getFileIcon = (file: FileResult) => {
  if (file.type === 'directory') {
    return <Folder className="h-5 w-5 text-blue-500" />;
  }
  
  const ext = file.extension?.toLowerCase() || '';
  
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    return <FileImage className="h-5 w-5 text-pink-500" />;
  }
  if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) {
    return <FileVideo className="h-5 w-5 text-purple-500" />;
  }
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) {
    return <FileAudio className="h-5 w-5 text-green-500" />;
  }
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) {
    return <FileArchive className="h-5 w-5 text-yellow-500" />;
  }
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'scss', 'html'].includes(ext)) {
    return <FileCode className="h-5 w-5 text-emerald-500" />;
  }
  if (['md', 'txt', 'json', 'yaml', 'yml', 'xml', 'csv'].includes(ext)) {
    return <FileText className="h-5 w-5 text-orange-500" />;
  }
  
  return <File className="h-5 w-5 text-muted-foreground" />;
};

const quickActions = [
  { id: 'files', name: 'Open Files', icon: Folder, shortcut: '⌘1' },
  { id: 'browser', name: 'Open Browser', icon: Globe, shortcut: '⌘2' },
  { id: 'terminal', name: 'Open Terminal', icon: Terminal, shortcut: '⌘3' },
];

export const SpotlightSearch = memo(function SpotlightSearch({
  isOpen,
  onClose,
  onFileSelect,
  onOpenFiles,
  onOpenBrowser,
  files = [],
}: SpotlightSearchProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredFiles = query.length > 0
    ? files.filter(file => 
        file.name.toLowerCase().includes(query.toLowerCase()) ||
        file.path.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 8)
    : [];

  const filteredActions = query.length === 0
    ? quickActions
    : quickActions.filter(action => 
        action.name.toLowerCase().includes(query.toLowerCase())
      );

  const allResults = [
    ...filteredActions.map(a => ({ type: 'action' as const, ...a })),
    ...filteredFiles.map(f => ({ type: 'file' as const, ...f })),
  ];

  const totalResults = allResults.length;

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = useCallback((index: number) => {
    const item = allResults[index];
    if (!item) return;

    if (item.type === 'action') {
      if (item.id === 'files') onOpenFiles?.();
      if (item.id === 'browser') onOpenBrowser?.();
      onClose();
    } else if (item.type === 'file') {
      onFileSelect?.(item.path);
      onClose();
    }
  }, [allResults, onClose, onFileSelect, onOpenFiles, onOpenBrowser]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % Math.max(1, totalResults));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + totalResults) % Math.max(1, totalResults));
        break;
      case 'Enter':
        e.preventDefault();
        handleSelect(selectedIndex);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [totalResults, selectedIndex, handleSelect, onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    const selectedElement = listRef.current?.children[selectedIndex] as HTMLElement;
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-[100]"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 1, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30, opacity: { duration: 0.15 } }}
            className="fixed left-1/2 top-[20%] -translate-x-1/2 w-full max-w-xl z-[101]"
          >
            <Card variant="glass" className="overflow-hidden gap-0 py-0">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                <Search className="h-5 w-5 text-muted-foreground shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Search files, actions..."
                  className="flex-1 bg-transparent text-foreground text-lg placeholder:text-muted-foreground outline-none"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <kbd className="hidden sm:inline-flex h-6 items-center gap-1 rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground">
                  <span>esc</span>
                </kbd>
              </div>

              <div ref={listRef} className="max-h-[400px] overflow-y-auto p-2">
                {query.length === 0 && (
                  <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Quick Actions
                  </div>
                )}

                {filteredActions.length > 0 && query.length === 0 && (
                  <div className="space-y-1">
                    {filteredActions.map((action, index) => {
                      const Icon = action.icon;
                      const isSelected = index === selectedIndex;
                      return (
                        <button
                          key={action.id}
                          onClick={() => handleSelect(index)}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left",
                            isSelected ? "bg-accent" : "hover:bg-accent/50"
                          )}
                        >
                          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                            <Icon className="h-5 w-5 text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-foreground">{action.name}</div>
                          </div>
                          <kbd className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md">
                            {action.shortcut}
                          </kbd>
                        </button>
                      );
                    })}
                  </div>
                )}

                {query.length > 0 && filteredFiles.length > 0 && (
                  <>
                    <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Files
                    </div>
                    <div className="space-y-1">
                      {filteredFiles.map((file, index) => {
                        const actualIndex = filteredActions.length + index;
                        const isSelected = actualIndex === selectedIndex;
                        return (
                          <button
                            key={file.path}
                            onClick={() => handleSelect(actualIndex)}
                            className={cn(
                              "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left",
                              isSelected ? "bg-accent" : "hover:bg-accent/50"
                            )}
                          >
                            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                              {getFileIcon(file)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-foreground truncate">{file.name}</div>
                              <div className="text-xs text-muted-foreground truncate">{file.path}</div>
                            </div>
                            {isSelected && (
                              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}

                {query.length > 0 && filteredFiles.length === 0 && filteredActions.length === 0 && (
                  <div className="px-3 py-8 text-center text-muted-foreground">
                    <Search className="h-10 w-10 mx-auto mb-3 opacity-50" />
                    <p>No results for "{query}"</p>
                  </div>
                )}
              </div>

              <div className="px-4 py-2.5 border-t border-border bg-muted/30 flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 rounded bg-muted">↑</kbd>
                    <kbd className="px-1.5 py-0.5 rounded bg-muted">↓</kbd>
                    <span className="ml-1">Navigate</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 rounded bg-muted">↵</kbd>
                    <span className="ml-1">Open</span>
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Command className="h-3 w-3" />
                  <span>/ to search</span>
                </div>
              </div>
            </Card>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
});

SpotlightSearch.displayName = 'SpotlightSearch';
