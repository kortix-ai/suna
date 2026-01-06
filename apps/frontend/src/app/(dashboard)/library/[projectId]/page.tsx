'use client';

import React, { useCallback, useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { 
  ArrowLeft, 
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
  Music,
  MoreHorizontal,
  Star,
  SlidersHorizontal,
  ChevronDown
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useProjectQuery } from '@/hooks/threads/use-project';
import { useThreads } from '@/hooks/threads/use-threads';
import { useDirectoryQuery } from '@/hooks/files/use-file-queries';
import { getFileUrl } from '@/lib/utils/file-utils';
import { useAuth } from '@/components/AuthProvider';
import { toast } from '@/lib/toast';
import JSZip from 'jszip';
import { listSandboxFiles, type FileInfo } from '@/lib/api/sandbox';
import { usePresentationViewerStore, PresentationViewerWrapper } from '@/stores/presentation-viewer-store';
import { useFileViewerStore, FileViewerWrapper } from '@/stores/file-viewer-store';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';

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

// Large preview card for presentations with title header
const PresentationCard = React.memo(function PresentationCard({
  thumbnailUrl,
  thumbnailTitle,
  onClick,
  onDownload,
}: {
  thumbnailUrl: string;
  thumbnailTitle: string;
  onClick: () => void;
  onDownload?: (format: 'zip' | 'pptx' | 'pdf') => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.1);
  const [iframeError, setIframeError] = React.useState(false);

  React.useEffect(() => {
    if (!containerRef.current) return;
    
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
  }, []);

  return (
    <div 
      className="bg-card rounded-2xl border border-border overflow-hidden cursor-pointer group hover:border-border/80 transition-colors"
      onClick={onClick}
    >
      {/* Header with icon, title and menu */}
      <div className="flex items-center gap-3 p-4 border-b border-border/50">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-muted/50">
          <Presentation className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="flex-1 font-medium truncate text-sm">{thumbnailTitle}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button 
              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onClick(); }}>
              Open
            </DropdownMenuItem>
            {onDownload && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger onClick={(e) => e.stopPropagation()}>
                  Download
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDownload('zip'); }}>
                    Download as ZIP
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDownload('pptx'); }}>
                    Download as PPTX
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDownload('pdf'); }}>
                    Download as PDF
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      
      {/* Large preview */}
      <div 
        ref={containerRef}
        className="w-full aspect-video relative overflow-hidden"
      >
        {thumbnailUrl && !iframeError ? (
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
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/20">
            <Presentation className="h-16 w-16 text-muted-foreground/40" />
          </div>
        )}
      </div>
    </div>
  );
});

// Image card with preview - fetches image with auth and creates blob URL
const ImageCard = React.memo(function ImageCard({
  imageUrl,
  displayName,
  accessToken,
  onClick,
}: {
  imageUrl: string;
  displayName: string;
  accessToken?: string;
  onClick: () => void;
}) {
  const [imageBlobUrl, setImageBlobUrl] = React.useState<string | null>(null);
  const [imageError, setImageError] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    if (!imageUrl || !accessToken) {
      setIsLoading(false);
      return;
    }

    let isMounted = true;
    let blobUrl: string | null = null;
    
    const fetchImage = async () => {
      try {
        const response = await fetch(imageUrl, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to fetch image');
        
        const blob = await response.blob();
        if (isMounted) {
          blobUrl = URL.createObjectURL(blob);
          setImageBlobUrl(blobUrl);
          setIsLoading(false);
        }
      } catch (error) {
        if (isMounted) {
          setImageError(true);
          setIsLoading(false);
        }
      }
    };

    fetchImage();

    return () => {
      isMounted = false;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [imageUrl, accessToken]);

  return (
    <div 
      className="bg-card rounded-2xl border border-border overflow-hidden cursor-pointer group hover:border-border/80 transition-colors"
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-border/50">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-muted/50">
          <Image className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="flex-1 font-medium truncate text-sm">{displayName}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button 
              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onClick(); }}>
              Open image
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      
      {/* Preview */}
      <div className="w-full aspect-[16/10] relative overflow-hidden bg-muted/10">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-muted-foreground/20 border-t-muted-foreground/60 rounded-full animate-spin" />
          </div>
        ) : imageBlobUrl && !imageError ? (
          <img
            src={imageBlobUrl}
            alt={displayName}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Image className="h-16 w-16 text-muted-foreground/40" />
          </div>
        )}
      </div>
    </div>
  );
});

// Generic file card
const FileCard = React.memo(function FileCard({
  fileName,
  displayName,
  onClick,
}: {
  fileName: string;
  displayName: string;
  onClick: () => void;
}) {
  const IconComponent = getFileIcon(fileName);

  return (
    <div 
      className="bg-card rounded-2xl border border-border overflow-hidden cursor-pointer group hover:border-border/80 transition-colors"
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-border/50">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-muted/50">
          <IconComponent className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="flex-1 font-medium truncate text-sm">{displayName}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button 
              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onClick(); }}>
              Open file
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      
      {/* Preview placeholder */}
      <div className="w-full aspect-[16/10] relative overflow-hidden bg-muted/10 flex items-center justify-center">
        <IconComponent className="h-16 w-16 text-muted-foreground/30" />
      </div>
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

  const [isDownloading, setIsDownloading] = useState(false);
  const [presentationThumbnails, setPresentationThumbnails] = useState<Record<string, PresentationThumbnail>>({});

  // Fetch project data - force refetch to ensure we have sandbox data
  const { data: project, isLoading: isProjectLoading } = useProjectQuery(projectId, {
    refetchOnMount: 'always',
    staleTime: 0,
  });
  
  // Also fetch threads list as fallback source for sandbox data (increased limit)
  const { data: threadsResponse, isLoading: isThreadsLoading } = useThreads({
    page: 1,
    limit: 200,
  });

  // Find sandbox ID from project or threads
  const sandboxId = useMemo(() => {
    // First try project query - this is the primary source
    if (project?.sandbox?.id) {
      return project.sandbox.id;
    }
    
    // Fallback: find thread with this project_id in the threads list
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
  
  // File viewer store
  const { openFile } = useFileViewerStore();

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

  // Fetch files from the root workspace
  const {
    data: rootFiles = [],
    isLoading: isRootFilesLoading,
    isError: isRootFilesError,
  } = useDirectoryQuery(sandboxId || '', '/workspace', {
    enabled: !!sandboxId && sandboxId.trim() !== '',
    staleTime: 0,
  });

  // Fetch files from the presentations folder (non-blocking - may not exist)
  const {
    data: presentationFiles = [],
    isLoading: isPresentationsLoading,
    isError: isPresentationsError,
  } = useDirectoryQuery(sandboxId || '', '/workspace/presentations', {
    enabled: !!sandboxId && sandboxId.trim() !== '',
    staleTime: 0,
  });

  // Combine all files - include presentation files only if successfully loaded
  const files = useMemo(() => {
    const allFiles = [...rootFiles];
    // Only add presentation files if they loaded successfully (folder exists)
    if (!isPresentationsError && presentationFiles.length > 0) {
      allFiles.push(...presentationFiles);
    }
    return allFiles;
  }, [rootFiles, presentationFiles, isPresentationsError]);

  // Only wait for root files - presentations folder may not exist
  const isFilesLoading = isRootFilesLoading;

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

  // Filter to show only relevant outputs: presentations, images, documents (no regular folders)
  const relevantOutputs = useMemo(() => {
    const outputs: Array<{
      type: 'presentation' | 'image' | 'file';
      file: FileInfo;
      thumbnail?: PresentationThumbnail;
    }> = [];

    files.forEach(file => {
      // Check if it's a presentation folder
      if (file.is_dir && isPresentationFolder(file)) {
        const thumbnail = presentationThumbnails[file.path];
        // Show presentation even if metadata hasn't loaded yet (will show placeholder)
        // Only skip if we've confirmed there's no metadata
        outputs.push({ type: 'presentation', file, thumbnail });
        return;
      }
      
      // Skip other directories
      if (file.is_dir) return;
      
      // Check if it's an image
      if (isImageFile(file.name)) {
        outputs.push({ type: 'image', file });
        return;
      }
      
      // Include other files (documents, etc.)
      outputs.push({ type: 'file', file });
    });

    return outputs;
  }, [files, presentationThumbnails, isPresentationFolder]);

  // Handle file/folder click
  const handleItemClick = useCallback(async (file: FileInfo) => {
    if (file.is_dir) {
      // Check if it's a presentation with valid metadata
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
    } else {
      // Open file in file viewer
      if (sandboxId && session?.access_token) {
        // Get display name based on project name
        const ext = file.name.split('.').pop() || '';
        const displayName = ext ? `${projectName}.${ext}` : projectName;
        
        openFile({
          sandboxId,
          filePath: file.path,
          fileName: file.name,
          displayName,
          accessToken: session.access_token,
        });
      }
    }
  }, [sandboxId, sandboxUrl, isPresentationFolder, openPresentation, presentationThumbnails, openFile, session?.access_token, projectName]);

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

      await exploreDirectory('/workspace');

      if (allFiles.length === 0) {
        toast.error('No files found to download');
        return;
      }

      const zip = new JSZip();
      const basePath = '/workspace/';

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
  }, [sandboxId, session?.access_token, projectName, isDownloading]);

  // Download a single presentation folder in specified format
  const handleDownloadPresentation = useCallback(async (
    folderPath: string, 
    presentationTitle: string,
    format: 'zip' | 'pptx' | 'pdf'
  ) => {
    if (!sandboxId || !session?.access_token || isDownloading) return;

    try {
      setIsDownloading(true);
      
      // For PPTX and PDF, we need to call a backend conversion endpoint
      if (format === 'pptx' || format === 'pdf') {
        toast.info(`Preparing ${format.toUpperCase()} download...`);
        
        try {
          const response = await fetch(
            `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/presentations/export?path=${encodeURIComponent(folderPath)}&format=${format}`,
            {
              headers: { 'Authorization': `Bearer ${session.access_token}` }
            }
          );

          if (response.ok) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${presentationTitle || 'presentation'}.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toast.success(`Downloaded as ${format.toUpperCase()}`);
          } else {
            toast.error(`${format.toUpperCase()} export not available yet`);
          }
        } catch (error) {
          console.error(`${format} export failed:`, error);
          toast.error(`${format.toUpperCase()} export not available yet`);
        }
        return;
      }

      // ZIP download - collect all files
      toast.info('Preparing ZIP download...');

      // Recursively collect all files in the presentation folder
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

      await exploreDirectory(folderPath);

      if (allFiles.length === 0) {
        toast.error('No files found in presentation');
        return;
      }

      const zip = new JSZip();

      for (const file of allFiles) {
        // Get relative path from the presentation folder
        const relativePath = file.path.startsWith(folderPath)
          ? file.path.slice(folderPath.length + 1)
          : file.name;

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
      a.download = `${presentationTitle || 'presentation'}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Downloaded as ZIP`);
    } catch (error) {
      console.error('Presentation download failed:', error);
      toast.error('Failed to download presentation');
    } finally {
      setIsDownloading(false);
    }
  }, [sandboxId, session?.access_token, isDownloading]);

  const isLoading = isProjectLoading || isThreadsLoading || isFilesLoading;
  const hasSandbox = !!sandboxId && sandboxId.trim() !== '';

  return (
    <>
    <PresentationViewerWrapper />
    <FileViewerWrapper />
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <div className="px-8 pt-8 pb-6">
        <div className="flex items-center gap-4 mb-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.back()}
            className="h-9 w-9"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          
          <h1 className="text-2xl font-semibold">Library</h1>

          <div className="flex-1" />

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

        {/* Filter buttons */}
        <div className="flex items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="rounded-full gap-2">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                All
                <ChevronDown className="h-3 w-3 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem>All</DropdownMenuItem>
              <DropdownMenuItem>Presentations</DropdownMenuItem>
              <DropdownMenuItem>Images</DropdownMenuItem>
              <DropdownMenuItem>Documents</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" size="sm" className="rounded-full gap-2">
            <Star className="h-3.5 w-3.5" />
            My favorites
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <KortixLoader size="medium" />
          </div>
        ) : !hasSandbox || relevantOutputs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
              <div className="w-14 h-14 flex items-center justify-center rounded-xl bg-muted/50">
                <Presentation className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-lg font-semibold">No files yet</h3>
                <p className="text-sm text-muted-foreground">
                  Start a conversation to create presentations, documents, and more.
                </p>
              </div>
              {threadId ? (
                <Button 
                  onClick={() => router.push(`/projects/${projectId}/thread/${threadId}`)}
                  size="sm"
                  className="mt-2"
                >
                  Create your first file
                </Button>
              ) : (
                <Button 
                  onClick={() => router.push('/dashboard')}
                  size="sm"
                  className="mt-2"
                >
                  Start a new chat
                </Button>
              )}
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="px-8 pb-8">
              {/* Project section */}
              <div className="mb-8">
                <h2 className="text-lg font-semibold mb-4">{projectName}</h2>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {relevantOutputs.map((output) => {
                    const { type, file, thumbnail } = output;
                    
                    if (type === 'presentation') {
                      // Get presentation name from path for fallback title
                      const presentationName = file.path.split('/').filter(Boolean).pop() || 'Presentation';
                      const displayTitle = thumbnail?.title || presentationName;
                      
                      return (
                        <PresentationCard
                          key={file.path}
                          thumbnailUrl={thumbnail?.firstSlideUrl || ''}
                          thumbnailTitle={displayTitle}
                          onClick={() => handleItemClick(file)}
                          onDownload={(format) => handleDownloadPresentation(file.path, displayTitle, format)}
                        />
                      );
                    }
                    
                    if (type === 'image') {
                      const imageUrl = sandboxId ? getFileUrl(sandboxId, file.path) : '';
                      // Use project name as display name, with file extension
                      const ext = file.name.split('.').pop() || '';
                      const displayName = ext ? `${projectName}.${ext}` : projectName;
                      return (
                        <ImageCard
                          key={file.path}
                          imageUrl={imageUrl}
                          displayName={displayName}
                          accessToken={session?.access_token}
                          onClick={() => handleItemClick(file)}
                        />
                      );
                    }
                    
                    // Use project name as display name, with file extension
                    const ext = file.name.split('.').pop() || '';
                    const displayName = ext ? `${projectName}.${ext}` : projectName;
                    return (
                      <FileCard
                        key={file.path}
                        fileName={file.name}
                        displayName={displayName}
                        onClick={() => handleItemClick(file)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
    </>
  );
}
