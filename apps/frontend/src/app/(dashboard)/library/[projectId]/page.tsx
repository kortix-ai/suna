'use client';

import React, { useCallback, useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { 
  ArrowLeft, 
  Folder, 
  Home, 
  ChevronRight, 
  Download, 
  MessageSquare,
  Presentation,
  Image,
  FileText,
  FileCode,
  File,
  FileSpreadsheet,
  FileArchive,
  Film,
  Music
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { useProjectQuery } from '@/hooks/threads/use-project';
import { useThreads } from '@/hooks/threads/use-threads';
import { useDirectoryQuery } from '@/hooks/files/use-file-queries';
import { getFileUrl } from '@/lib/utils/file-utils';
import { useAuth } from '@/components/AuthProvider';
import { toast } from '@/lib/toast';
import JSZip from 'jszip';
import { listSandboxFiles, type FileInfo } from '@/lib/api/sandbox';
import { usePresentationViewerStore, PresentationViewerWrapper } from '@/stores/presentation-viewer-store';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';

interface PresentationThumbnail {
  firstSlideUrl: string;
  title: string;
  hasMetadata: boolean;
}

// Check if file is an image
function isImageFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'].includes(ext);
}

// Get Lucide icon based on file extension
function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
  // Images
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff'].includes(ext)) {
    return Image;
  }
  
  // Videos
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv'].includes(ext)) {
    return Film;
  }
  
  // Audio
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(ext)) {
    return Music;
  }
  
  // Archives
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(ext)) {
    return FileArchive;
  }
  
  // Spreadsheets
  if (['csv', 'xls', 'xlsx', 'ods'].includes(ext)) {
    return FileSpreadsheet;
  }
  
  // Code files
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 
       'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'php', 'swift',
       'kt', 'scala', 'sh', 'bash', 'zsh', 'sql', 'json', 'yaml', 'yml', 'xml', 'toml'].includes(ext)) {
    return FileCode;
  }
  
  // Documents
  if (['txt', 'md', 'rtf', 'doc', 'docx', 'odt', 'pdf'].includes(ext)) {
    return FileText;
  }
  
  // Default
  return File;
}

// Thumbnail component with proper dynamic scaling
const ThumbnailContainer = React.memo(function ThumbnailContainer({
  isPresentation,
  isImage,
  thumbnailUrl,
  thumbnailTitle,
  imageUrl,
  fileName,
  isDir,
  hasPresentationMetadata,
}: {
  isPresentation: boolean;
  isImage: boolean;
  thumbnailUrl?: string | null;
  thumbnailTitle?: string;
  imageUrl?: string | null;
  fileName: string;
  isDir: boolean;
  hasPresentationMetadata: boolean;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.1);
  const [imageError, setImageError] = React.useState(false);
  const [iframeError, setIframeError] = React.useState(false);

  React.useEffect(() => {
    if (!containerRef.current || !isPresentation) return;
    
    const updateScale = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth;
        setScale(width / 1920);
      }
    };

    updateScale();
    
    const resizeObserver = new ResizeObserver(updateScale);
    resizeObserver.observe(containerRef.current);
    
    return () => resizeObserver.disconnect();
  }, [isPresentation]);

  const IconComponent = getFileIcon(fileName);

  return (
    <div 
      ref={containerRef}
      className="w-full aspect-video flex items-center justify-center mb-2 rounded-lg overflow-hidden border border-border/20 bg-muted/5 relative"
    >
      {isPresentation && thumbnailUrl && !iframeError ? (
        <iframe
          src={thumbnailUrl}
          className="pointer-events-none border-0 absolute top-0 left-0"
          style={{ 
            width: '1920px', 
            height: '1080px',
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
          title={thumbnailTitle || 'Presentation'}
          loading="lazy"
          onError={() => setIframeError(true)}
        />
      ) : isImage && imageUrl && !imageError ? (
        <img
          src={imageUrl}
          alt={fileName}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
          onError={() => setImageError(true)}
        />
      ) : (
        <div className="grayscale opacity-60 group-hover:opacity-80 transition-opacity">
          {hasPresentationMetadata ? (
            <Presentation className="h-10 w-10" />
          ) : isDir ? (
            <Folder className="h-10 w-10" />
          ) : (
            <IconComponent className="h-10 w-10" />
          )}
        </div>
      )}
    </div>
  );
});

export default function LibraryBrowserPage({
  params,
}: {
  params: Promise<{
    projectId: string;
  }>;
}) {
  const unwrappedParams = React.use(params);
  const { projectId } = unwrappedParams;
  const router = useRouter();
  const { session } = useAuth();

  const [currentPath, setCurrentPath] = useState('/workspace');
  const [isDownloading, setIsDownloading] = useState(false);
  const [presentationThumbnails, setPresentationThumbnails] = useState<Record<string, PresentationThumbnail>>({});

  // Fetch project data - try multiple sources to find sandbox ID
  const { data: project, isLoading: isProjectLoading } = useProjectQuery(projectId);
  
  // Also fetch threads list as fallback source for sandbox data
  const { data: threadsResponse, isLoading: isThreadsLoading } = useThreads({
    page: 1,
    limit: 50,
  });

  // Find sandbox ID from project or threads
  const sandboxId = useMemo(() => {
    // First try project query
    if (project?.sandbox?.id) {
      return project.sandbox.id;
    }
    
    // Fallback: find thread with this project_id
    const thread = threadsResponse?.threads?.find(t => t.project_id === projectId);
    if (thread?.project?.sandbox?.id) {
      return thread.project.sandbox.id;
    }
    
    return null;
  }, [project, threadsResponse, projectId]);

  // Get thread ID for navigation to chat
  const threadId = useMemo(() => {
    const thread = threadsResponse?.threads?.find(t => t.project_id === projectId);
    return thread?.thread_id;
  }, [threadsResponse, projectId]);

  // Get project name from available sources
  const projectName = project?.name || 
    threadsResponse?.threads?.find(t => t.project_id === projectId)?.project?.name || 
    'Files';

  // Get sandbox URL for presentation viewer
  const sandboxUrl = useMemo(() => {
    if (project?.sandbox?.sandbox_url) {
      return project.sandbox.sandbox_url;
    }
    const thread = threadsResponse?.threads?.find(t => t.project_id === projectId);
    return thread?.project?.sandbox?.sandbox_url || '';
  }, [project, threadsResponse, projectId]);

  // Presentation viewer store
  const { openPresentation } = usePresentationViewerStore();

  // Check if a folder is a presentation folder
  const isPresentationFolder = useCallback((file: FileInfo): boolean => {
    if (!file.is_dir) return false;
    
    const pathParts = file.path.split('/').filter(Boolean);
    
    // Check if parent folder is "presentations" and this is a direct child
    // Path should be like: /workspace/presentations/my_presentation
    if (pathParts.length >= 3) {
      const parentIndex = pathParts.length - 2;
      if (pathParts[parentIndex] === 'presentations') {
        return true;
      }
    }
    
    return false;
  }, []);

  // Fetch files from the sandbox
  const {
    data: files = [],
    isLoading: isFilesLoading,
  } = useDirectoryQuery(sandboxId || '', currentPath, {
    enabled: !!sandboxId && sandboxId.trim() !== '',
    staleTime: 0,
  });

  // Helper to sanitize filename (matching backend logic)
  const sanitizeFilename = useCallback((name: string): string => {
    return name.replace(/[^a-zA-Z0-9\-_]/g, '').toLowerCase();
  }, []);

  // Fetch presentation thumbnails for folders in /presentations
  useEffect(() => {
    if (!sandboxUrl || !files.length) return;

    const presentationFolders = files.filter(f => isPresentationFolder(f));
    
    presentationFolders.forEach(async (folder) => {
      // Skip if already fetched
      if (presentationThumbnails[folder.path]) return;

      const presentationName = folder.path.split('/').filter(Boolean).pop() || '';
      const sanitizedName = sanitizeFilename(presentationName);
      
      try {
        const metadataUrl = constructHtmlPreviewUrl(
          sandboxUrl,
          `presentations/${sanitizedName}/metadata.json`
        );
        
        if (!metadataUrl) return;
        
        const response = await fetch(`${metadataUrl}?t=${Date.now()}`, {
          cache: 'no-cache',
        });
        
        if (response.ok) {
          const metadata = await response.json();
          const slides = Object.entries(metadata.slides || {})
            .map(([num, slide]: [string, any]) => ({ number: parseInt(num), ...slide }))
            .sort((a, b) => a.number - b.number);
          
          if (slides.length > 0) {
            const firstSlide = slides[0];
            const slideUrl = constructHtmlPreviewUrl(sandboxUrl, firstSlide.file_path);
            
            setPresentationThumbnails(prev => ({
              ...prev,
              [folder.path]: {
                firstSlideUrl: slideUrl || '',
                title: metadata.title || presentationName,
                hasMetadata: true,
              }
            }));
          }
        }
      } catch (error) {
        // Silently fail - just won't show thumbnail
        console.debug('Failed to fetch presentation metadata:', error);
      }
    });
  }, [files, sandboxUrl, isPresentationFolder, presentationThumbnails, sanitizeFilename]);

  // Sort files: folders first, then by name
  const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [files]);

  // Calculate file stats
  const fileStats = useMemo(() => {
    let fileCount = 0;
    files.forEach(file => {
      if (!file.is_dir) {
        fileCount++;
      }
    });
    return { files: fileCount };
  }, [files]);

  // Navigate to a path
  const navigateToPath = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  // Handle file/folder click
  const handleItemClick = useCallback(async (file: FileInfo) => {
    if (file.is_dir) {
      // Check if it's a presentation with valid metadata (already fetched)
      const thumbnail = presentationThumbnails[file.path];
      if (thumbnail?.hasMetadata && sandboxUrl) {
        const presentationName = file.path.split('/').filter(Boolean).pop() || '';
        openPresentation(presentationName, sandboxUrl, 1);
        return;
      }
      
      // Check if it's potentially a presentation folder that we haven't fetched yet
      if (isPresentationFolder(file) && sandboxId && !thumbnail) {
        try {
          const folderContents = await listSandboxFiles(sandboxId, file.path);
          const hasMetadata = folderContents.some(f => f.name === 'metadata.json');
          
          if (hasMetadata && sandboxUrl) {
            const presentationName = file.path.split('/').filter(Boolean).pop() || '';
            openPresentation(presentationName, sandboxUrl, 1);
            return;
          }
        } catch (error) {
          console.error('Failed to check presentation folder:', error);
        }
      }
      
      // Not a presentation or no metadata - navigate into folder
      navigateToPath(file.path);
    } else {
      // Open file in new tab
      if (sandboxId) {
        const fileUrl = getFileUrl(sandboxId, file.path);
        window.open(fileUrl, '_blank');
      }
    }
  }, [navigateToPath, sandboxId, sandboxUrl, isPresentationFolder, openPresentation, presentationThumbnails]);

  // Generate breadcrumb segments
  const getBreadcrumbSegments = useCallback((path: string) => {
    const cleanPath = path.replace(/^\/workspace\/?/, '');
    if (!cleanPath) return [];

    const parts = cleanPath.split('/').filter(Boolean);
    let currentBreadcrumbPath = '/workspace';

    return parts.map((part, index) => {
      currentBreadcrumbPath = `${currentBreadcrumbPath}/${part}`;
      return {
        name: part,
        path: currentBreadcrumbPath,
        isLast: index === parts.length - 1,
      };
    });
  }, []);

  const breadcrumbs = getBreadcrumbSegments(currentPath);

  // Download all files as zip
  const handleDownloadAll = useCallback(async () => {
    if (!sandboxId || !session?.access_token || isDownloading) return;

    try {
      setIsDownloading(true);
      toast.info('Preparing download...');

      // Recursively collect all files
      const allFiles: FileInfo[] = [];
      const visited = new Set<string>();

      const exploreDirectory = async (dirPath: string) => {
        if (visited.has(dirPath)) return;
        visited.add(dirPath);

        try {
          const dirFiles = await listSandboxFiles(sandboxId, dirPath);
          for (const file of dirFiles) {
            if (file.is_dir) {
              await exploreDirectory(file.path);
            } else {
              allFiles.push(file);
            }
          }
        } catch (error) {
          console.error(`Failed to read directory: ${dirPath}`, error);
        }
      };

      await exploreDirectory(currentPath);

      if (allFiles.length === 0) {
        toast.error('No files found to download');
        return;
      }

      const zip = new JSZip();
      const basePath = currentPath.endsWith('/') ? currentPath : currentPath + '/';

      for (const file of allFiles) {
        const relativePath = file.path.startsWith(basePath)
          ? file.path.slice(basePath.length)
          : file.path.replace(/^\/workspace\//, '');

        try {
          const response = await fetch(
            `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(file.path)}`,
            {
              headers: { 'Authorization': `Bearer ${session.access_token}` }
            }
          );

          if (response.ok) {
            const blob = await response.blob();
            zip.file(relativePath, blob);
          }
        } catch (error) {
          console.error(`Failed to download file: ${file.path}`, error);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName || 'files'}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Downloaded ${allFiles.length} files`);
    } catch (error) {
      console.error('Download failed:', error);
      toast.error('Failed to download files');
    } finally {
      setIsDownloading(false);
    }
  }, [sandboxId, session?.access_token, currentPath, projectName, isDownloading]);

  const isLoading = isProjectLoading || isThreadsLoading || isFilesLoading;
  const hasSandbox = !!sandboxId && sandboxId.trim() !== '';
  const isAtRoot = currentPath === '/workspace';

  return (
    <>
    <PresentationViewerWrapper />
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.back()}
            className="h-9 w-9"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          
          <div>
            <h1 className="text-base font-medium">
              {projectName}
            </h1>
            {fileStats.files > 0 && (
              <p className="text-xs text-muted-foreground">
                {fileStats.files} file{fileStats.files !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {threadId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/projects/${projectId}/thread/${threadId}`)}
              className="text-muted-foreground"
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownloadAll}
            disabled={isDownloading || !hasSandbox || files.length === 0}
            className="text-muted-foreground"
          >
            {isDownloading ? (
              <KortixLoader size="small" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Breadcrumb - only show when not at root */}
      {!isAtRoot && (
        <div className="px-6 py-2 border-b border-border/30">
          <div className="flex items-center gap-1 text-sm">
            <button
              onClick={() => navigateToPath('/workspace')}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <Home className="h-3.5 w-3.5" />
            </button>
            
            {breadcrumbs.map((segment) => (
              <React.Fragment key={segment.path}>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                <button
                  onClick={() => navigateToPath(segment.path)}
                  className={cn(
                    "transition-colors truncate max-w-[150px]",
                    segment.isLast 
                      ? "text-foreground" 
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {segment.name}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* File Browser Content */}
      <div className="flex-1 overflow-hidden relative">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <KortixLoader size="medium" />
          </div>
        ) : !hasSandbox ? (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="flex flex-col items-center space-y-4 text-center">
              <div className="w-16 h-16 flex items-center justify-center grayscale opacity-40">
                <Folder className="h-12 w-12" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-medium">No files yet</h3>
                <p className="text-sm text-muted-foreground">
                  Start a task to create files.
                </p>
              </div>
            </div>
          </div>
        ) : sortedFiles.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="flex flex-col items-center space-y-6 max-w-md text-center">
              <div className="w-16 h-16 flex items-center justify-center grayscale opacity-40">
                <Folder className="h-12 w-12" />
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-medium">Empty folder</h3>
                <p className="text-sm text-muted-foreground">
                  This folder doesn't contain any files yet.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="p-8">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {sortedFiles.map((file) => {
                  const isPresentation = isPresentationFolder(file);
                  const thumbnail = presentationThumbnails[file.path];
                  const isImage = !file.is_dir && isImageFile(file.name);
                  const imageUrl = isImage && sandboxId ? getFileUrl(sandboxId, file.path) : null;
                  
                  return (
                    <button
                      key={file.path}
                      onClick={() => handleItemClick(file)}
                      className="group flex flex-col items-center p-3 rounded-xl hover:bg-muted/40 transition-colors"
                    >
                      <ThumbnailContainer
                        isPresentation={!!(isPresentation && thumbnail?.firstSlideUrl)}
                        isImage={!!(isImage && imageUrl)}
                        thumbnailUrl={thumbnail?.firstSlideUrl}
                        thumbnailTitle={thumbnail?.title}
                        imageUrl={imageUrl}
                        fileName={file.name}
                        isDir={file.is_dir}
                        hasPresentationMetadata={!!(isPresentation && thumbnail?.hasMetadata)}
                      />
                      <span className="text-xs text-center text-muted-foreground group-hover:text-foreground truncate w-full transition-colors">
                        {file.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
    </>
  );
}
