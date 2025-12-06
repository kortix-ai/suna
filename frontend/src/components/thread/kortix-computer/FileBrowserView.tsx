'use client';

import { useState, useEffect, useRef, Fragment, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  File,
  Folder,
  Upload,
  ChevronRight,
  Home,
  Loader,
  FileText,
  Archive,
  Presentation,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  listSandboxFiles,
  type FileInfo,
} from '@/lib/api/sandbox';
import { Project } from '@/lib/api/threads';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/AuthProvider';
import {
  useDirectoryQuery,
  FileCache
} from '@/hooks/files';
import { useDownloadRestriction } from '@/hooks/billing';
import JSZip from 'jszip';
import { normalizeFilenameToNFC } from '@/lib/utils/unicode';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { Badge } from '@/components/ui/badge';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

interface FileBrowserViewProps {
  sandboxId: string;
  project?: Project;
  projectId?: string;
}

export function FileBrowserView({
  sandboxId,
  project,
  projectId,
}: FileBrowserViewProps) {
  const { session } = useAuth();
  
  // Kortix Computer Store
  const { 
    currentPath, 
    navigateToPath,
    openFile,
  } = useKortixComputerStore();
  
  // Download restriction for free tier users
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'files',
  });

  // Use React Query for directory listing
  const {
    data: files = [],
    isLoading: isLoadingFiles,
    error: filesError,
    refetch: refetchFiles,
    failureCount: dirRetryAttempt,
  } = useDirectoryQuery(sandboxId || '', currentPath, {
    enabled: !!sandboxId && sandboxId.trim() !== '' && !!currentPath,
    staleTime: 0,
  });

  // Utility state
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    current: number;
    total: number;
    currentFile: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check computer status
  const hasSandbox = !!(project?.sandbox?.id || sandboxId);
  const isComputerStarted = project?.sandbox?.sandbox_url ? true : false;

  // Function to ensure a path starts with /workspace
  const normalizePath = useCallback((path: unknown): string => {
    if (typeof path !== 'string' || !path) {
      return '/workspace';
    }
    return path.startsWith('/workspace')
      ? path
      : `/workspace/${path.replace(/^\//, '')}`;
  }, []);

  // Function to generate breadcrumb segments from a path
  const getBreadcrumbSegments = useCallback(
    (path: string) => {
      const normalizedPath = normalizePath(path);
      const cleanPath = normalizedPath.replace(/^\/workspace\/?/, '');
      if (!cleanPath) return [];

      const parts = cleanPath.split('/').filter(Boolean);
      let currentPath = '/workspace';

      return parts.map((part, index) => {
        currentPath = `${currentPath}/${part}`;
        return {
          name: part,
          path: currentPath,
          isLast: index === parts.length - 1,
        };
      });
    },
    [normalizePath],
  );

  // Helper function to navigate to home
  const navigateHome = useCallback(() => {
    navigateToPath('/workspace');
  }, [navigateToPath]);

  // Navigate to a specific path in the breadcrumb
  const navigateToBreadcrumb = useCallback(
    (path: string) => {
      navigateToPath(path);
    },
    [navigateToPath],
  );

  // Check if a folder is a presentation folder
  // A presentation folder is a direct child of /workspace/presentations/ or /presentations/
  // NOT any nested folder inside a presentation (like images/, assets/, etc.)
  const isPresentationFolder = useCallback((file: FileInfo): boolean => {
    if (!file.is_dir) return false;
    
    // Get the parent path
    const pathParts = file.path.split('/').filter(Boolean);
    
    // Check if parent folder is "presentations" and this is a direct child
    // Path should be like: /workspace/presentations/my_presentation
    // PathParts would be: ["workspace", "presentations", "my_presentation"]
    if (pathParts.length >= 3) {
      const parentIndex = pathParts.length - 2; // Index of the parent folder
      if (pathParts[parentIndex] === 'presentations') {
        return true;
      }
    }
    
    return false;
  }, []);

  // Handle file or folder click
  const handleItemClick = useCallback(
    (file: FileInfo) => {
      if (file.is_dir) {
        // Check if it's a presentation folder (direct child of /presentations/)
        if (isPresentationFolder(file)) {
          // Open presentation in viewer
          openFile(file.path);
        } else {
          // Navigate to folder
          navigateToPath(file.path);
        }
      } else {
        // Open file in viewer
        openFile(file.path);
      }
    },
    [navigateToPath, openFile, isPresentationFolder],
  );

  // Recursive function to discover all files from the current path
  const discoverAllFiles = useCallback(async (
    startPath: string = currentPath
  ): Promise<{ files: FileInfo[], totalSize: number }> => {
    const allFiles: FileInfo[] = [];
    let totalSize = 0;
    const visited = new Set<string>();

    const exploreDirectory = async (dirPath: string) => {
      if (visited.has(dirPath)) return;
      visited.add(dirPath);

      try {
        const files = await listSandboxFiles(sandboxId, dirPath);

        for (const file of files) {
          if (file.is_dir) {
            await exploreDirectory(file.path);
          } else {
            allFiles.push(file);
            totalSize += file.size || 0;
          }
        }
      } catch (error) {
        console.error(`Failed to read directory: ${dirPath}`, error);
      }
    };

    await exploreDirectory(startPath);

    return { files: allFiles, totalSize };
  }, [sandboxId]);

  // Function to download all files as a zip from current directory
  const handleDownloadFolder = useCallback(async () => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!session?.access_token || isDownloadingAll) return;

    try {
      setIsDownloadingAll(true);
      setDownloadProgress({ current: 0, total: 0, currentFile: 'Discovering files...' });

      const { files } = await discoverAllFiles(currentPath);

      if (files.length === 0) {
        toast.error('No files found to download');
        return;
      }

      const zip = new JSZip();
      setDownloadProgress({ current: 0, total: files.length, currentFile: 'Creating archive...' });

      // Get the base path for relative paths in the zip
      const basePath = currentPath.endsWith('/') ? currentPath : currentPath + '/';

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Make path relative to the current folder
        const relativePath = file.path.startsWith(basePath) 
          ? file.path.slice(basePath.length)
          : file.path.replace(/^\/workspace\//, '');

        setDownloadProgress({
          current: i + 1,
          total: files.length,
          currentFile: relativePath
        });

        try {
          const contentType = FileCache.getContentTypeFromPath(file.path);
          const cacheKey = `${sandboxId}:${file.path}:${contentType}`;
          let content = FileCache.get(cacheKey);

          if (!content) {
            if (!sandboxId || sandboxId.trim() === '') {
              continue;
            }
            const response = await fetch(
              `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(file.path)}`,
              {
                headers: { 'Authorization': `Bearer ${session.access_token}` }
              }
            );

            if (!response.ok) {
              continue;
            }

            if (contentType === 'blob') {
              content = await response.blob();
            } else if (contentType === 'json') {
              content = JSON.stringify(await response.json(), null, 2);
            } else {
              content = await response.text();
            }

            FileCache.set(cacheKey, content);
          }

          if (content instanceof Blob) {
            zip.file(relativePath, content);
          } else if (typeof content === 'string') {
            if (content.startsWith('blob:')) {
              try {
                const blobResponse = await fetch(content);
                const blobContent = await blobResponse.blob();
                zip.file(relativePath, blobContent);
              } catch (blobError) {
                if (!sandboxId || sandboxId.trim() === '') {
                  continue;
                }
                const fallbackResponse = await fetch(
                  `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(file.path)}`,
                  { headers: { 'Authorization': `Bearer ${session.access_token}` } }
                );
                if (fallbackResponse.ok) {
                  const fallbackBlob = await fallbackResponse.blob();
                  zip.file(relativePath, fallbackBlob);
                }
              }
            } else {
              zip.file(relativePath, content);
            }
          } else {
            zip.file(relativePath, JSON.stringify(content, null, 2));
          }

        } catch (fileError) {
          // Continue with other files
        }
      }

      setDownloadProgress({
        current: files.length,
        total: files.length,
        currentFile: 'Generating zip file...'
      });

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      // Generate a meaningful name based on current path
      const folderName = currentPath === '/workspace' 
        ? 'workspace' 
        : currentPath.split('/').filter(Boolean).pop() || 'folder';
      
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${folderName}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => URL.revokeObjectURL(url), 10000);

      toast.success(`Downloaded ${files.length} files as zip archive`);

    } catch (error) {
      toast.error(`Failed to create zip archive: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsDownloadingAll(false);
      setDownloadProgress(null);
    }
  }, [sandboxId, session?.access_token, isDownloadingAll, discoverAllFiles, isDownloadRestricted, openUpgradeModal, currentPath]);

  // Handle file upload
  const handleUpload = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  }, []);

  // Process uploaded file
  const processUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!event.target.files || event.target.files.length === 0) return;

      const file = event.target.files[0];
      setIsUploading(true);

      try {
        const normalizedName = normalizeFilenameToNFC(file.name);
        const uploadPath = `/workspace/uploads/${normalizedName}`;

        const formData = new FormData();
        formData.append('file', file, normalizedName);
        formData.append('path', uploadPath);

        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.access_token) {
          throw new Error('No access token available');
        }

        if (!sandboxId || sandboxId.trim() === '') {
          toast.error('Computer is not started yet. Please wait for it to be ready.');
          setIsUploading(false);
          return;
        }

        const response = await fetch(
          `${API_URL}/sandboxes/${sandboxId}/files`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            body: formData,
          },
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(error || 'Upload failed');
        }

        const responseData = await response.json();
        const finalFilename = responseData.final_filename || normalizedName;
        const wasRenamed = responseData.renamed || false;

        await refetchFiles();

        if (wasRenamed) {
          toast.success(`Uploaded as: ${finalFilename} (renamed to avoid conflict)`);
        } else {
          toast.success(`Uploaded: ${finalFilename}`);
        }
      } catch (error) {
        toast.error(
          `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setIsUploading(false);
        if (event.target) event.target.value = '';
      }
    },
    [sandboxId, refetchFiles],
  );

  // Get file icon based on type
  const getFileIcon = useCallback((file: FileInfo) => {
    if (file.is_dir) {
      if (isPresentationFolder(file)) {
        return <Presentation className="h-9 w-9 text-orange-500" />;
      }
      return <Folder className="h-9 w-9 text-blue-500" />;
    }
    
    const extension = file.name.split('.').pop()?.toLowerCase();
    
    // Check for specific file types
    if (['md', 'txt', 'doc'].includes(extension || '')) {
      return <FileText className="h-8 w-8 text-muted-foreground" />;
    }
    
    return <File className="h-8 w-8 text-muted-foreground" />;
  }, [isPresentationFolder]);

  return (
    <div className="flex flex-col h-full max-w-full overflow-hidden min-w-0">
      {/* Header with Breadcrumb Navigation */}
      <div className="px-3 py-2 flex items-center justify-between border-b flex-shrink-0 bg-muted/30 max-w-full min-w-0">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 overflow-x-auto min-w-0 scrollbar-hide max-w-full">
          <button
            onClick={navigateHome}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors flex-shrink-0"
            title="Home"
          >
            <Home className="h-3.5 w-3.5" />
          </button>

          {currentPath !== '/workspace' && (
            <>
              {getBreadcrumbSegments(currentPath).map((segment, index) => (
                <Fragment key={segment.path}>
                  <ChevronRight className="h-3 w-3 text-muted-foreground/50 flex-shrink-0" />
                  <button
                    onClick={() => navigateToBreadcrumb(segment.path)}
                    className={cn(
                      "px-2 py-1 text-xs font-medium rounded transition-colors truncate max-w-[150px]",
                      segment.isLast 
                        ? "text-foreground bg-muted" 
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                  >
                    {segment.name}
                  </button>
                </Fragment>
              ))}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          {/* Download progress */}
          {downloadProgress && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2">
              <Loader className="h-3 w-3 animate-spin" />
              <span>
                {downloadProgress.total > 0
                  ? `${downloadProgress.current}/${downloadProgress.total}`
                  : 'Preparing...'
                }
              </span>
            </div>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownloadFolder}
            disabled={isDownloadingAll || isLoadingFiles}
            className="h-7 px-2 gap-1.5 text-xs"
          >
            {isDownloadingAll ? (
              <Loader className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Archive className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">Download</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleUpload}
            disabled={isUploading}
            className="h-7 px-2 gap-1.5 text-xs"
          >
            {isUploading ? (
              <Loader className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">Upload</span>
          </Button>

          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            onChange={processUpload}
            disabled={isUploading}
          />
        </div>
      </div>

      {/* File Explorer */}
      <div className="flex-1 overflow-hidden max-w-full min-w-0">
        {isLoadingFiles ? (
          <div className="h-full w-full max-w-full flex flex-col items-center justify-center gap-2 min-w-0">
            <Loader className="h-6 w-6 animate-spin text-primary" />
            {dirRetryAttempt > 0 && (
              <p className="text-xs text-muted-foreground">
                Retrying... (attempt {dirRetryAttempt + 1})
              </p>
            )}
          </div>
        ) : files.length === 0 ? (
          <div className="h-full w-full flex flex-col items-center justify-center gap-2">
            <Folder className="h-12 w-12 mb-2 text-muted-foreground opacity-30" />
            {!hasSandbox ? (
              <>
                <p className="text-sm font-medium text-muted-foreground">
                  Computer is not available yet
                </p>
                <p className="text-xs text-muted-foreground/70">
                  A computer will be created when you start working on this task
                </p>
              </>
            ) : !isComputerStarted ? (
              <>
                <p className="text-sm font-medium text-muted-foreground">
                  Computer is not started yet
                </p>
                <p className="text-xs text-muted-foreground/70">
                  Files will appear once the computer is ready
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Directory is empty
              </p>
            )}
          </div>
        ) : (
          <ScrollArea className="h-full w-full max-w-full p-2 min-w-0">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4 max-w-full min-w-0">
              {files.map((file) => (
                <button
                  key={file.path}
                  className={cn(
                    "flex flex-col items-center p-3 rounded-2xl border hover:bg-muted/50 transition-colors relative max-w-full min-w-0",
                  )}
                  onClick={() => handleItemClick(file)}
                >
                  {/* Presentation badge */}
                  {isPresentationFolder(file) && (
                    <Badge 
                      variant="secondary" 
                      className="absolute top-1 right-1 text-[10px] px-1.5 py-0 bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
                    >
                      Presentation
                    </Badge>
                  )}
                  
                  <div className="w-12 h-12 flex items-center justify-center mb-1 flex-shrink-0">
                    {getFileIcon(file)}
                  </div>
                  <span className="text-xs text-center font-medium truncate max-w-full w-full min-w-0">
                    {file.name}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

