'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  File,
  Folder,
  ChevronRight,
  ChevronUp,
  FileText,
  Coffee,
} from 'lucide-react';
import {
  listSandboxFiles,
  getSandboxFileContent,
  type FileInfo,
} from '@/lib/api';
import { toast } from 'sonner';
import { useDraggable } from '@dnd-kit/core';

// Draggable file item component
function DraggableFileItem({
  file,
  selectedFile,
  onClick
}: {
  file: FileInfo;
  selectedFile: string | null;
  onClick: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `file-browser-${file.path}`,
    data: {
      type: 'external-file',
      file: file,
      source: 'file-browser'
    }
  });

  const style = transform ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    opacity: isDragging ? 0.5 : 1,
  } : undefined;

  return (
    <Button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      variant={selectedFile === file.path ? 'secondary' : 'ghost'}
      className="w-full justify-start text-sm mb-1 cursor-grab active:cursor-grabbing"
      onClick={onClick}
    >
      <FileText className="h-4 w-4 mr-2" />
      {file.name}
    </Button>
  );
}

interface FileBrowserProps {
  sandboxId: string;
  onSelectFile?: (path: string, content: string) => void;
  trigger?: React.ReactNode;
}

export function FileBrowser({
  sandboxId,
  onSelectFile,
  trigger,
}: FileBrowserProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadFiles('');
    } else {
      setFileContent(null);
      setSelectedFile(null);
    }
  }, [isOpen, sandboxId]);

  // Load files from the current path
  const loadFiles = async (path: string) => {
    setIsLoading(true);
    try {
      const files = await listSandboxFiles(sandboxId, path);
      setFiles(files);
      setCurrentPath(path);

      // Update breadcrumbs
      if (path === '') {
        setBreadcrumbs([]);
      } else {
        const parts = path.split('/').filter(Boolean);
        setBreadcrumbs(parts);
      }
    } catch (error) {
      toast.error('Failed to load files');
      console.error('Failed to load files:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Load file content
  const loadFileContent = async (path: string) => {
    setIsLoading(true);
    setSelectedFile(path);
    try {
      const content = await getSandboxFileContent(sandboxId, path);
      if (typeof content === 'string') {
        setFileContent(content);
      } else {
        // For binary files, show a message
        setFileContent('[Binary file]');
      }
    } catch (error) {
      toast.error('Failed to load file content');
      console.error('Failed to load file content:', error);
      setFileContent(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle file or folder click
  const handleItemClick = (file: FileInfo) => {
    if (file.is_dir) {
      loadFiles(file.path);
    } else {
      loadFileContent(file.path);
    }
  };

  // Navigate to a specific breadcrumb
  const navigateToBreadcrumb = (index: number) => {
    if (index === -1) {
      // Root directory
      loadFiles('');
    } else {
      const path = breadcrumbs.slice(0, index + 1).join('/');
      loadFiles(path);
    }
  };

  // Handle select button click
  const handleSelectFile = () => {
    if (selectedFile && fileContent && onSelectFile) {
      onSelectFile(selectedFile, fileContent);
      setIsOpen(false);
    }
  };

  const handleAddToKnowledgeBase = () => {
    if (selectedFile && fileContent) {
      // Create a blob and download the file so user can upload it to knowledge base
      const blob = new Blob([fileContent], { type: 'text/plain' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selectedFile.split('/').pop() || 'file.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success('File downloaded - you can now upload it to knowledge base using the Upload Files button');
      setIsOpen(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        {trigger || <Button variant="outline">Browse Files</Button>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[800px] max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Sandbox Files</DialogTitle>
        </DialogHeader>

        {/* Breadcrumbs */}
        <div className="flex items-center space-x-1 text-sm py-2 border-b">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() => navigateToBreadcrumb(-1)}
          >
            <Folder className="h-4 w-4 mr-1" />
            root
          </Button>
          {breadcrumbs.map((part, index) => (
            <div key={index} className="flex items-center">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2"
                onClick={() => navigateToBreadcrumb(index)}
              >
                {part}
              </Button>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4 flex-1 overflow-hidden">
          {/* File list */}
          <div className="border rounded-md overflow-y-auto h-[400px]">
            {isLoading && !files.length ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : files.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Coffee className="h-8 w-8 mb-2" />
                <p>No files found</p>
              </div>
            ) : (
              <div className="p-2">
                {currentPath !== '' && (
                  <Button
                    variant="ghost"
                    className="w-full justify-start text-sm mb-1"
                    onClick={() => {
                      const parentPath = currentPath
                        .split('/')
                        .slice(0, -1)
                        .join('/');
                      loadFiles(parentPath);
                    }}
                  >
                    <ChevronUp className="h-4 w-4 mr-2" />
                    ..
                  </Button>
                )}
                {files.map((file) => (
                  file.is_dir ? (
                    <Button
                      key={file.path}
                      variant="ghost"
                      className="w-full justify-start text-sm mb-1"
                      onClick={() => handleItemClick(file)}
                    >
                      <Folder className="h-4 w-4 mr-2" />
                      {file.name}
                    </Button>
                  ) : (
                    <DraggableFileItem
                      key={file.path}
                      file={file}
                      selectedFile={selectedFile}
                      onClick={() => handleItemClick(file)}
                    />
                  )
                ))}
              </div>
            )}
          </div>

          {/* File preview */}
          <div className="border rounded-md overflow-hidden flex flex-col">
            <div className="p-2 bg-muted text-sm font-medium border-b">
              {selectedFile ? selectedFile.split('/').pop() : 'File Preview'}
            </div>
            <div className="p-2 overflow-y-auto flex-1 h-[360px]">
              {isLoading && selectedFile ? (
                <div className="space-y-2">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              ) : fileContent ? (
                <pre className="text-xs whitespace-pre-wrap">{fileContent}</pre>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <File className="h-8 w-8 mb-2" />
                  <p>Select a file to preview</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {selectedFile && fileContent && onSelectFile && (
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={handleAddToKnowledgeBase}>
              Add to Knowledge Base
            </Button>
            <Button onClick={handleSelectFile}>Select File</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
