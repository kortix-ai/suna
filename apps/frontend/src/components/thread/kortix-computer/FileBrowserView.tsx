'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Folder,
  Upload,
  Download,
  ChevronRight,
  Home,
  ChevronDown,
  AlertTriangle,
  File,
  FileText,
  Presentation,
  ArrowLeft,
  MessageSquare,
  Image,
  FileCode,
  FileSpreadsheet,
  FileArchive,
  Film,
  Music,
  MoreHorizontal,
  Eye,
  ExternalLink,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  listSandboxFiles,
  type FileInfo,
} from '@/lib/api/sandbox';
import { Project } from '@/lib/api/threads';
import { toast } from '@/lib/toast';
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
import { useFileViewerStore } from '@/stores/file-viewer-store';
import { usePresentationViewerStore } from '@/stores/presentation-viewer-store';
import { Badge } from '@/components/ui/badge';
import { VersionBanner } from './VersionBanner';
import { KortixComputerHeader } from './KortixComputerHeader';
import { useFileData } from '@/hooks/use-file-data';
import { PresentationSlidePreview } from '../tool-views/presentation-tools/PresentationSlidePreview';
import { PdfRenderer } from '@/components/file-renderers/pdf-renderer';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Image extensions for thumbnail preview
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff'];

// Document extensions (main outputs)
const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'];

// Spreadsheet extensions (main outputs)
const SPREADSHEET_EXTENSIONS = ['xlsx', 'xls', 'csv', 'ods'];

// Video extensions (for thumbnail support)
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'];

// Audio extensions
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];

// Video/Audio extensions (main outputs)
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

// Folders to hide in library view (internal/utility folders)
const HIDDEN_FOLDERS = ['downloads', 'node_modules', '.git', '__pycache__', 'assets', 'images', 'fonts', 'scripts', 'src', 'dist', 'build', 'public', 'static'];

// Check if a file is a main output (something the user generated/requested)
function isMainOutput(file: FileInfo, isPresentationFolder: (f: FileInfo) => boolean): boolean {
  // Presentation folders are main outputs
  if (file.is_dir && isPresentationFolder(file)) {
    return true;
  }
  
  // Hide other folders (downloads, assets, etc.)
  if (file.is_dir) {
    const folderName = file.name.toLowerCase();
    // Hide known internal folders
    if (HIDDEN_FOLDERS.includes(folderName)) {
      return false;
    }
    // Hide folders that start with . (hidden folders)
    if (folderName.startsWith('.')) {
      return false;
    }
    // Hide generic folders - only show presentation folders
    return false;
  }
  
  // For files, check if they're main output types
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  
  // Images are main outputs
  if (IMAGE_EXTENSIONS.includes(extension)) {
    return true;
  }
  
  // Documents are main outputs
  if (DOCUMENT_EXTENSIONS.includes(extension)) {
    return true;
  }
  
  // Spreadsheets are main outputs
  if (SPREADSHEET_EXTENSIONS.includes(extension)) {
    return true;
  }
  
  // Media files are main outputs
  if (MEDIA_EXTENSIONS.includes(extension)) {
    return true;
  }
  
  // HTML files can be outputs (web pages, reports)
  if (extension === 'html' || extension === 'htm') {
    return true;
  }
  
  // Hide everything else (code files, configs, etc.)
  return false;
}

// Simple CSV parser for thumbnail preview
function parseCSV(content: string): string[][] {
  const lines = content.split('\n').filter(line => line.trim());
  return lines.map(line => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  });
}

// XLSX Thumbnail - fetches and parses XLSX files for static preview
function XlsxThumbnail({ 
  sandboxId, 
  filePath 
}: { 
  sandboxId: string; 
  filePath: string; 
}) {
  const { session } = useAuth();
  const [data, setData] = useState<string[][] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  useEffect(() => {
    let cancelled = false;
    
    async function loadXlsx() {
      if (!sandboxId || !filePath) return;
      
      try {
        setIsLoading(true);
        const { fetchFileContent } = await import('@/hooks/files/use-file-queries');
        const blob = await fetchFileContent(sandboxId, filePath, 'blob', session?.access_token || '');
        
        if (cancelled) return;
        
        const XLSX = await import('xlsx');
        const arrayBuffer = await (blob as Blob).arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array', cellText: false, cellDates: true });
        
        if (cancelled) return;
        
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) {
          setData([]);
          return;
        }
        
        const ws = workbook.Sheets[firstSheetName];
        const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        
        // Convert to string[][] for SpreadsheetThumbnail
        const stringData = rows.map(row => 
          (row as any[]).map(cell => cell == null ? '' : String(cell))
        );
        
        if (!cancelled) {
          setData(stringData);
        }
      } catch (error) {
        console.error('[XlsxThumbnail] Failed to parse XLSX:', error);
        if (!cancelled) {
          setData([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }
    
    loadXlsx();
    return () => { cancelled = true; };
  }, [sandboxId, filePath, session?.access_token]);
  
  return <SpreadsheetThumbnail data={data || []} isLoading={isLoading} />;
}

// Video thumbnail component - captures first frame
function VideoThumbnail({ 
  url, 
  fallbackIcon 
}: { 
  url: string; 
  fallbackIcon: React.ReactNode;
}) {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  
  useEffect(() => {
    if (!url) {
      setHasError(true);
      setIsLoading(false);
      return;
    }
    
    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    
    const captureFrame = () => {
      if (cancelled) return;
      
      try {
        // Ensure we have valid dimensions
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          console.warn('Video dimensions not available');
          setHasError(true);
          setIsLoading(false);
          return;
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          if (!cancelled) {
            setThumbnail(dataUrl);
            setIsLoading(false);
          }
        } else {
          setHasError(true);
          setIsLoading(false);
        }
      } catch (e) {
        console.error('Failed to capture video frame:', e);
        if (!cancelled) {
          setHasError(true);
          setIsLoading(false);
        }
      }
    };
    
    const handleCanPlay = () => {
      if (cancelled) return;
      // Set to a small time offset to ensure we get the first frame
      video.currentTime = 0.01;
    };
    
    const handleSeeked = () => {
      if (cancelled) return;
      // Small delay to ensure frame is rendered
      requestAnimationFrame(() => {
        captureFrame();
      });
    };
    
    const handleError = (e: Event) => {
      if (cancelled) return;
      console.error('Failed to load video for thumbnail:', e);
      setHasError(true);
      setIsLoading(false);
    };
    
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('error', handleError);
    
    video.src = url;
    
    return () => {
      cancelled = true;
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('error', handleError);
      video.pause();
      video.src = '';
      video.load();
    };
  }, [url]);
  
  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted/10">
        <KortixLoader size="small" />
      </div>
    );
  }
  
  if (hasError || !thumbnail) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted/10">
        {fallbackIcon}
      </div>
    );
  }
  
  return (
    <div className="w-full h-full relative">
      <img
        src={thumbnail}
        alt="Video thumbnail"
        className="w-full h-full object-cover"
      />
      {/* Video play icon overlay */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
          <Film className="h-5 w-5 text-white" />
        </div>
      </div>
    </div>
  );
}

// Static spreadsheet thumbnail - completely non-interactive
function SpreadsheetThumbnail({ data, isLoading }: { data: string[][]; isLoading?: boolean }) {
  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-white dark:bg-zinc-900">
        <KortixLoader size="small" />
      </div>
    );
  }
  
  if (!data || data.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted/10">
        <FileSpreadsheet className="h-12 w-12 text-muted-foreground" />
      </div>
    );
  }
  
  // Show first 12 rows and first 6 columns
  const maxRows = 12;
  const maxCols = 6;
  const rows = data.slice(0, maxRows);
  
  return (
    <div 
      className="w-full h-full overflow-hidden bg-white dark:bg-zinc-900 pointer-events-none select-none"
      style={{ 
        transform: 'scale(0.55)', 
        transformOrigin: 'top left',
        width: '182%',
        height: '182%',
        padding: '4px'
      }}
    >
      <table className="text-[11px] border-collapse w-full table-fixed">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr 
              key={rowIndex} 
              className={rowIndex === 0 ? 'bg-muted/50 font-medium' : rowIndex % 2 === 0 ? 'bg-muted/20' : ''}
            >
              {row.slice(0, maxCols).map((cell, colIndex) => (
                <td 
                  key={colIndex} 
                  className="border border-border/40 px-1.5 py-0.5 truncate max-w-[120px] text-foreground"
                  title={cell}
                >
                  {cell || '\u00A0'}
                </td>
              ))}
              {/* Fill empty columns if row has fewer cells */}
              {row.length < maxCols && Array(maxCols - row.length).fill(0).map((_, i) => (
                <td key={`empty-${i}`} className="border border-border/40 px-1.5 py-0.5">{'\u00A0'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Thumbnail preview component for library cards
function ThumbnailPreview({ 
  file, 
  sandboxId, 
  project,
  isPresentationFolder,
  fallbackIcon
}: { 
  file: FileInfo; 
  sandboxId: string; 
  project?: Project;
  isPresentationFolder: boolean;
  fallbackIcon: React.ReactNode;
}) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const isImage = IMAGE_EXTENSIONS.includes(extension);
  const isVideo = VIDEO_EXTENSIONS.includes(extension);
  const isPdf = extension === 'pdf';
  const isCsv = extension === 'csv';
  const isXlsx = extension === 'xlsx' || extension === 'xls' || extension === 'ods';
  const isMarkdown = extension === 'md' || extension === 'markdown';
  const isText = extension === 'txt';
  
  // Determine what content to fetch
  const needsBlobContent = isImage || isPdf || isVideo;
  const needsTextContent = isMarkdown || isText || isCsv;
  
  // For images/PDFs, use blob content
  const { data: blobUrl, isLoading: blobLoading, error: blobError } = useFileData(
    needsBlobContent ? sandboxId : undefined,
    needsBlobContent ? file.path : undefined,
    { enabled: needsBlobContent, showPreview: true }
  );
  
  // For text files (including CSV), use text content  
  const { data: textContent, isLoading: textLoading, error: textError } = useFileData(
    needsTextContent ? sandboxId : undefined,
    needsTextContent ? file.path : undefined,
    { enabled: needsTextContent, showPreview: true }
  );
  
  const isLoading = blobLoading || textLoading;
  const hasError = blobError || textError;
  
  // For presentation folders, show the slide preview
  if (isPresentationFolder && project?.sandbox?.sandbox_url) {
    const presentationName = file.name;
    return (
      <PresentationSlidePreview
        presentationName={presentationName}
        project={project}
        className="w-full h-full"
      />
    );
  }
  
  // Loading state
  if (isLoading && (needsBlobContent || needsTextContent)) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted/10">
        <KortixLoader size="small" />
      </div>
    );
  }
  
  // For images, show the actual image thumbnail
  if (isImage && blobUrl && !hasError) {
    return (
      <img
        src={blobUrl}
        alt={file.name}
        className="w-full h-full object-cover"
        loading="lazy"
      />
    );
  }
  
  // For videos, show first frame thumbnail
  if (isVideo && blobUrl && !hasError) {
    return (
      <VideoThumbnail 
        url={blobUrl} 
        fallbackIcon={fallbackIcon} 
      />
    );
  }
  
  // For PDFs, show embedded PDF preview
  if (isPdf && blobUrl && !hasError) {
    return (
      <div className="w-full h-full overflow-hidden bg-white dark:bg-zinc-900">
        <PdfRenderer url={blobUrl} className="w-full h-full" />
      </div>
    );
  }
  
  // For CSV, show static spreadsheet thumbnail
  if (isCsv && textContent && !hasError) {
    const parsedData = parseCSV(textContent);
    return <SpreadsheetThumbnail data={parsedData} />;
  }
  
  // For XLSX, show static spreadsheet thumbnail
  if (isXlsx && sandboxId) {
    return <XlsxThumbnail sandboxId={sandboxId} filePath={file.path} />;
  }
  
  // For markdown, show rendered preview (scaled down to show more content)
  if (isMarkdown && textContent && !hasError) {
    return (
      <div className="w-full h-full overflow-hidden bg-white dark:bg-zinc-900 p-2">
        <div 
          className="prose prose-sm dark:prose-invert max-w-none overflow-hidden h-full origin-top-left"
          style={{ 
            transform: 'scale(0.55)', 
            transformOrigin: 'top left',
            width: '182%',
            height: '182%'
          }}
        >
          <UnifiedMarkdown content={textContent.slice(0, 1500)} />
        </div>
      </div>
    );
  }
  
  // For plain text, show text preview (scaled down like markdown for better readability)
  if (isText && textContent && !hasError) {
    return (
      <div className="w-full h-full overflow-hidden bg-zinc-50 dark:bg-zinc-900 p-2">
        <div 
          className="overflow-hidden h-full origin-top-left"
          style={{ 
            transform: 'scale(0.55)', 
            transformOrigin: 'top left',
            width: '182%',
            height: '182%'
          }}
        >
          <pre className="text-xs font-mono text-foreground leading-relaxed whitespace-pre-wrap break-words">
            {textContent.slice(0, 1500)}
          </pre>
        </div>
      </div>
    );
  }
  
  // Fallback to icon for other files or on error
  return (
    <div className="w-full h-full flex items-center justify-center bg-muted/10">
      {fallbackIcon}
    </div>
  );
}

interface FileBrowserViewProps {
  sandboxId: string;
  project?: Project;
  projectId?: string;
  /** 
   * 'default' - Side panel view in Kortix Computer (shows all files)
   * 'library' - Full page library view with larger cards and different layout
   * 'inline-library' - Side panel view with library filtering (main outputs only) and thumbnails
   */
  variant?: 'default' | 'library' | 'inline-library';
  /** Callback when user wants to navigate to thread (used in library view) */
  onNavigateToThread?: () => void;
}

export function FileBrowserView({
  sandboxId,
  project,
  projectId,
  variant = 'default',
  onNavigateToThread,
}: FileBrowserViewProps) {
  const isLibraryView = variant === 'library';
  const isInlineLibrary = variant === 'inline-library';
  const shouldFilterFiles = isLibraryView || isInlineLibrary;
  const { session } = useAuth();
  
  // Kortix Computer Store
  const { 
    currentPath, 
    navigateToPath,
    openFile,
    selectedVersion,
    selectedVersionDate,
    setSelectedVersion,
    clearSelectedVersion,
  } = useKortixComputerStore();

  // File viewer store (for library view - opens fullscreen modal)
  const openFileViewer = useFileViewerStore((state) => state.openFile);
  
  // Presentation viewer store (for library view - opens fullscreen presentation)
  const openPresentation = usePresentationViewerStore((state) => state.openPresentation);
  
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

  // Workspace version history state
  const [workspaceVersions, setWorkspaceVersions] = useState<Array<{ commit: string; author_name: string; author_email: string; date: string; message: string }>>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [versionFiles, setVersionFiles] = useState<FileInfo[]>([]);
  const [isLoadingVersionFiles, setIsLoadingVersionFiles] = useState(false);

  // Revert modal state
  const [revertModalOpen, setRevertModalOpen] = useState(false);
  const [revertCommitInfo, setRevertCommitInfo] = useState<any | null>(null);
  const [revertLoadingInfo, setRevertLoadingInfo] = useState(false);
  const [revertInProgress, setRevertInProgress] = useState(false);

  // Other files visibility state (for library views)
  const [showOtherFiles, setShowOtherFiles] = useState(false);

  // Check computer status
  const hasSandbox = !!(project?.sandbox?.id || sandboxId);
  const isComputerStarted = project?.sandbox?.sandbox_url ? true : false;

  // Function to ensure a path starts with /workspace
  const normalizePath = useCallback((path: unknown): string => {
    if (typeof path !== 'string' || !path) {
      return '/workspace';
    }
    // Handle paths that start with "workspace" (without leading /)
    if (path === 'workspace' || path.startsWith('workspace/')) {
      return '/' + path;
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
          // Presentations not supported in version view
          if (selectedVersion) {
            toast.info('Cannot view presentations from historical versions');
            return;
          }
          
          // In library view, open presentation in fullscreen viewer modal
          if (isLibraryView && project?.sandbox?.sandbox_url) {
            const presentationName = file.path.split('/').pop() || 'presentation';
            openPresentation(presentationName, project.sandbox.sandbox_url, 1);
          } else {
            // In side panel view, use kortix computer store
            openFile(file.path);
          }
        } else {
          // Navigate to folder (works in both current and version view)
          navigateToPath(file.path);
        }
      } else {
        // In library view, open file in fullscreen viewer modal
        if (isLibraryView && sandboxId && session?.access_token) {
          const fileName = file.path.split('/').pop() || 'file';
          openFileViewer({
            sandboxId,
            filePath: file.path,
            fileName,
            accessToken: session.access_token,
          });
        } else {
          // In side panel view, use kortix computer store
          // FileViewerView will detect selectedVersion from store
          openFile(file.path);
        }
      }
    },
    [navigateToPath, openFile, isPresentationFolder, selectedVersion, isLibraryView, sandboxId, session?.access_token, openFileViewer, openPresentation, project?.sandbox?.sandbox_url],
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
  }, [sandboxId, currentPath]);

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

  // Handle individual file download
  const handleDownloadFile = useCallback(async (filePath: string) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!session?.access_token || !sandboxId) {
      toast.error('Cannot download file');
      return;
    }

    const fileName = filePath.split('/').pop() || 'download';
    
    try {
      toast.loading(`Downloading ${fileName}...`, { id: 'download-file' });
      
      const response = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`,
        {
          headers: { 'Authorization': `Bearer ${session.access_token}` }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to download file');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success(`Downloaded ${fileName}`, { id: 'download-file' });
    } catch (error) {
      console.error('Download failed:', error);
      toast.error(`Failed to download ${fileName}`, { id: 'download-file' });
    }
  }, [sandboxId, session?.access_token, isDownloadRestricted, openUpgradeModal]);

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

  // Get file icon - supports 'default', 'large', 'header', 'small', and 'medium' variants
  // 'header' variant returns a gray, small icon (for card headers in library view)
  // 'small' variant returns tiny icons for compact cards (h-3 w-3)
  // 'medium' variant returns medium-small icons for compact cards (h-5 w-5)
  const getFileIcon = useCallback((file: FileInfo, variant: 'default' | 'large' | 'header' | 'small' | 'medium' = 'default') => {
    // Small and medium variants: tiny gray icons for compact cards
    if (variant === 'small' || variant === 'medium') {
      const iconClass = variant === 'small' ? "h-3 w-3 text-muted-foreground" : "h-5 w-5 text-muted-foreground";
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      
      if (file.is_dir) {
        if (isPresentationFolder(file)) {
          return <Presentation className={iconClass} />;
        }
        return <Folder className={iconClass} />;
      }
      
      if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff'].includes(extension)) {
        return <Image className={iconClass} />;
      }
      if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv'].includes(extension)) {
        return <Film className={iconClass} />;
      }
      if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(extension)) {
        return <Music className={iconClass} />;
      }
      if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(extension)) {
        return <FileArchive className={iconClass} />;
      }
      if (['csv', 'xls', 'xlsx', 'ods'].includes(extension)) {
        return <FileSpreadsheet className={iconClass} />;
      }
      if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 
           'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'php', 'swift',
           'kt', 'scala', 'sh', 'bash', 'zsh', 'sql', 'json', 'yaml', 'yml', 'xml', 'toml'].includes(extension)) {
        return <FileCode className={iconClass} />;
      }
      if (['md', 'txt', 'rtf', 'doc', 'docx', 'odt', 'pdf'].includes(extension)) {
        return <FileText className={iconClass} />;
      }
      return <File className={iconClass} />;
    }
    
    // Header variant: small gray icons matching thread icon style
    if (variant === 'header') {
      const iconClass = "h-4 w-4 text-muted-foreground";
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      
      if (file.is_dir) {
        if (isPresentationFolder(file)) {
          return <Presentation className={iconClass} />;
        }
        return <Folder className={iconClass} />;
      }
      
      if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff'].includes(extension)) {
        return <Image className={iconClass} />;
      }
      if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv'].includes(extension)) {
        return <Film className={iconClass} />;
      }
      if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(extension)) {
        return <Music className={iconClass} />;
      }
      if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(extension)) {
        return <FileArchive className={iconClass} />;
      }
      if (['csv', 'xls', 'xlsx', 'ods'].includes(extension)) {
        return <FileSpreadsheet className={iconClass} />;
      }
      if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 
           'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'php', 'swift',
           'kt', 'scala', 'sh', 'bash', 'zsh', 'sql', 'json', 'yaml', 'yml', 'xml', 'toml'].includes(extension)) {
        return <FileCode className={iconClass} />;
      }
      if (['md', 'txt', 'rtf', 'doc', 'docx', 'odt', 'pdf'].includes(extension)) {
        return <FileText className={iconClass} />;
      }
      return <File className={iconClass} />;
    }
    
    // Default and large variants - original colored icons
    const large = variant === 'large';
    const sizeClass = large ? "h-12 w-12" : "h-8 w-8";
    const largeSizeClass = large ? "h-14 w-14" : "h-9 w-9";
    
    if (file.is_dir) {
      if (isPresentationFolder(file)) {
        return <Presentation className={`${largeSizeClass} text-zinc-500 dark:text-zinc-400`} />;
      }
      return <Folder className={`${largeSizeClass} text-zinc-500 dark:text-zinc-400`} />;
    }
    
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    
    // Images
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff'].includes(extension)) {
      return <Image className={`${sizeClass} text-muted-foreground`} />;
    }
    
    // Videos
    if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv'].includes(extension)) {
      return <Film className={`${sizeClass} text-zinc-500 dark:text-zinc-400`} />;
    }
    
    // Audio
    if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(extension)) {
      return <Music className={`${sizeClass} text-zinc-500 dark:text-zinc-400`} />;
    }
    
    // Archives
    if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(extension)) {
      return <FileArchive className={`${sizeClass} text-zinc-500 dark:text-zinc-400`} />;
    }
    
    // Spreadsheets
    if (['csv', 'xls', 'xlsx', 'ods'].includes(extension)) {
      return <FileSpreadsheet className={`${sizeClass} text-zinc-500 dark:text-zinc-400`} />;
    }
    
    // Code files
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 
         'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'php', 'swift',
         'kt', 'scala', 'sh', 'bash', 'zsh', 'sql', 'json', 'yaml', 'yml', 'xml', 'toml'].includes(extension)) {
      return <FileCode className={`${sizeClass} text-zinc-500 dark:text-zinc-400`} />;
    }
    
    // Documents
    if (['md', 'txt', 'rtf', 'doc', 'docx', 'odt', 'pdf'].includes(extension)) {
      return <FileText className={`${sizeClass} text-muted-foreground`} />;
    }
    
    return <File className={`${sizeClass} text-muted-foreground`} />;
  }, [isPresentationFolder]);

  // Load workspace version history
  const loadWorkspaceHistory = useCallback(async (force: boolean = false) => {
    if (!sandboxId) return;
    if (workspaceVersions.length > 0 && !force) return; // already loaded
    setIsLoadingVersions(true);
    try {
      // Fetch git log for entire workspace (no specific path)
      const url = `${API_URL}/sandboxes/${sandboxId}/files/history?path=/workspace&limit=100`;
      const headers: Record<string, string> = {};
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch workspace history: ${response.statusText}`);
      }
      const data = await response.json();
      setWorkspaceVersions(data.versions || []);
      
      // If there's a selected version, update the date in the global store
      if (selectedVersion && data.versions && data.versions.length > 0) {
        const versionInfo = data.versions.find(v => v.commit === selectedVersion);
        if (versionInfo && versionInfo.date !== selectedVersionDate) {
          setSelectedVersion(selectedVersion, versionInfo.date);
        }
      }
      
      console.log('[FileBrowserView] Loaded workspace history', { count: (data.versions || []).length });
    } catch (error) {
      console.error('[FileBrowserView] Failed to load workspace history', error);
      toast.error('Failed to load workspace history');
    } finally {
      setIsLoadingVersions(false);
    }
  }, [sandboxId, session?.access_token, workspaceVersions.length, selectedVersion, selectedVersionDate, setSelectedVersion]);

  // Auto-load workspace history if we have a selected version but no date
  useEffect(() => {
    if (selectedVersion && !selectedVersionDate && sandboxId && workspaceVersions.length === 0) {
      console.log('[FileBrowserView] Auto-loading workspace history for selected version');
      loadWorkspaceHistory(true);
    }
  }, [selectedVersion, selectedVersionDate, sandboxId, workspaceVersions.length, loadWorkspaceHistory]);

  // Load files at selected version
  const loadFilesAtVersion = useCallback(async (commit: string | null, showToast: boolean = true) => {
    if (!commit) {
      // Return to current
      clearSelectedVersion();
      setVersionFiles([]);
      refetchFiles();
      return;
    }

    const versionDate = workspaceVersions.find(v => v.commit === commit)?.date;
    setSelectedVersion(commit, versionDate);

    // Load files at that commit using the new /files/tree endpoint
    setIsLoadingVersionFiles(true);
    try {
      const url = `${API_URL}/sandboxes/${sandboxId}/files/tree?path=${encodeURIComponent(currentPath)}&commit=${encodeURIComponent(commit)}`;
      const headers: Record<string, string> = {};
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch files at commit: ${response.statusText}`);
      }
      
      const data = await response.json();
      setVersionFiles(data.files || []);
      
      if (showToast && versionDate) {
        toast.success(`Viewing workspace from ${new Date(versionDate).toLocaleDateString()}`);
      }
    } catch (error) {
      console.error('[FileBrowserView] Failed to load files at version:', error);
      toast.error('Failed to load files at this version');
      clearSelectedVersion();
    } finally {
      setIsLoadingVersionFiles(false);
    }
  }, [sandboxId, currentPath, session?.access_token, workspaceVersions, refetchFiles, setSelectedVersion, clearSelectedVersion]);

  // Reload version files when currentPath changes while viewing a version
  useEffect(() => {
    if (selectedVersion) {
      loadFilesAtVersion(selectedVersion, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, selectedVersion]); // Don't include loadFilesAtVersion to avoid loops

  // Open revert modal and fetch commit info
  const openRevertModal = useCallback(async (commit: string) => {
    if (!commit || !sandboxId) return;
    setRevertModalOpen(true);
    setRevertLoadingInfo(true);
    setRevertCommitInfo(null);
    try {
      const url = `${API_URL}/sandboxes/${sandboxId}/files/commit-info?commit=${encodeURIComponent(commit)}`;
      const res = await fetch(url, { headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {} });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to fetch commit info');
      }
      const data = await res.json();
      setRevertCommitInfo(data);
    } catch (error) {
      console.error('Failed to load commit info:', error);
      toast.error('Failed to load commit info');
      setRevertModalOpen(false);
    } finally {
      setRevertLoadingInfo(false);
    }
  }, [sandboxId, session?.access_token]);

  // Perform revert (always entire commit for workspace history)
  const performRevert = useCallback(async () => {
    if (!revertCommitInfo || !sandboxId) return;
    setRevertInProgress(true);
    try {
      // Always revert entire commit (no paths specified)
      const body: any = { commit: revertCommitInfo.commit };

      const res = await fetch(`${API_URL}/sandboxes/${sandboxId}/files/revert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Revert failed');
      }

      const result = await res.json();
      console.log('[FileBrowserView] Revert result', result);

      // Close modal first for better UX
      setRevertModalOpen(false);

      // Clear selected version to return to current
      clearSelectedVersion();

      // Clear version history to force reload next time
      setWorkspaceVersions([]);

      // Refetch files to show the reverted state
      console.log('[FileBrowserView] Refetching files after restore');
      await refetchFiles();

      toast.success('Version restored successfully');
    } catch (error) {
      console.error('[FileBrowserView] Revert error', error);
      toast.error(`Failed to restore version: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRevertInProgress(false);
    }
  }, [revertCommitInfo, sandboxId, session?.access_token, refetchFiles, clearSelectedVersion]);

  // Library view header actions
  const libraryHeaderActions = (
    <>
      {onNavigateToThread && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onNavigateToThread}
          className="text-muted-foreground"
        >
          <MessageSquare className="h-4 w-4" />
        </Button>
      )}
      
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDownloadFolder}
        disabled={isDownloadingAll || isLoadingFiles || files.length === 0}
        className="text-muted-foreground"
      >
        {isDownloadingAll ? (
          <KortixLoader size="small" />
        ) : (
          <Download className="h-4 w-4" />
        )}
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={handleUpload}
        disabled={isUploading || !!selectedVersion}
        className="text-muted-foreground"
      >
        {isUploading ? (
          <KortixLoader size="small" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
      </Button>

      {/* Version history dropdown for library */}
      <DropdownMenu onOpenChange={(open) => { if (open) loadWorkspaceHistory(false); }}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={isLoadingFiles}
            className="gap-1.5 text-muted-foreground"
          >
            {isLoadingVersions ? (
              <KortixLoader size="small" />
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            {selectedVersion && selectedVersionDate && (
              <span className="text-xs">
                {new Date(selectedVersionDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[400px] overflow-y-auto w-[320px]">
          {isLoadingVersions ? (
            <div className="flex items-center justify-center py-8">
              <KortixLoader size="small" />
              <span className="ml-2 text-sm text-muted-foreground">Loading history...</span>
            </div>
          ) : workspaceVersions.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-sm text-muted-foreground">No history available</span>
            </div>
          ) : (
            workspaceVersions.map((version, index) => {
              const isCurrent = index === 0;
              const isSelected = isCurrent ? !selectedVersion : selectedVersion === version.commit;
              const parts = (version.message || '').split(':');
              return (
                <DropdownMenuItem
                  key={version.commit}
                  onClick={() => loadFilesAtVersion(isCurrent ? null : version.commit)}
                  className={cn("flex items-start gap-2 cursor-pointer py-2.5 px-3 rounded-xl", isSelected && "bg-accent")}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between mb-1">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-sm">{parts[0]}</div>
                        {parts.length > 1 && <div className="text-xs text-muted-foreground mt-0.5 truncate">{parts.slice(1).join(':').trim()}</div>}
                      </div>
                      {!isCurrent && (
                        <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); openRevertModal(version.commit); }} className="h-6 px-2 text-[11px] ml-3 shrink-0 rounded-full hover:bg-muted">
                          <span className="text-[11px]">Restore</span>
                        </Button>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(version.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(version.date).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })} at {new Date(version.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                    </div>
                  </div>
                </DropdownMenuItem>
              );
            })
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <input type="file" ref={fileInputRef} className="hidden" onChange={processUpload} disabled={isUploading} />
    </>
  );

  // Default side-panel header actions
  const defaultHeaderActions = (
    <>
      {/* Download progress */}
      {downloadProgress && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2">
          <KortixLoader size="small" />
          <span>
            {downloadProgress.total > 0
              ? `${downloadProgress.current}/${downloadProgress.total}`
              : 'Preparing...'
            }
          </span>
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={handleDownloadFolder}
        disabled={isDownloadingAll || isLoadingFiles}
        className="h-8 w-8 p-0 bg-transparent border border-border rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50"
        title="Download folder"
      >
        {isDownloadingAll ? (
          <KortixLoader size="small" />
        ) : (
          <Download className="h-4 w-4" />
        )}
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={handleUpload}
        disabled={isUploading || !!selectedVersion}
        className="h-8 w-8 p-0 bg-transparent border border-border rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50"
        title={selectedVersion ? 'Cannot upload while viewing historical version' : 'Upload file'}
      >
        {isUploading ? (
          <KortixLoader size="small" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
      </Button>

      <div className="flex-1" />

      {/* Version history dropdown */}
      <DropdownMenu onOpenChange={(open) => { if (open) loadWorkspaceHistory(false); }}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={isLoadingFiles}
            className="h-8 px-3 gap-1.5 text-xs bg-transparent border border-border rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50"
          >
            {isLoadingVersions ? (
              <KortixLoader size="small" />
            ) : (
              <svg className="h-3.5 w-3.5 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span>
              {selectedVersion && selectedVersionDate ? (
                new Date(selectedVersionDate).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric'
                })
              ) : (
                'History'
              )}
            </span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[400px] overflow-y-auto w-[320px]">
          {isLoadingVersions ? (
            <div className="flex items-center justify-center py-8">
              <KortixLoader size="small" />
              <span className="ml-2 text-sm text-muted-foreground">Loading history...</span>
            </div>
          ) : workspaceVersions.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-sm text-muted-foreground">No history available</span>
            </div>
          ) : (
            workspaceVersions.map((version, index) => {
              const isCurrent = index === 0;
              const isSelected = isCurrent ? !selectedVersion : selectedVersion === version.commit;
              const parts = (version.message || '').split(':');

              return (
                <DropdownMenuItem
                  key={version.commit}
                  onClick={() => loadFilesAtVersion(isCurrent ? null : version.commit)}
                  className={cn(
                    "flex items-start gap-2 cursor-pointer py-2.5 px-3 rounded-xl",
                    isSelected && "bg-accent"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between mb-1">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-sm">
                          {parts[0]}
                        </div>
                        {parts.length > 1 && (
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">
                            {parts.slice(1).join(':').trim()}
                          </div>
                        )}
                      </div>

                      {!isCurrent && (
                        <div className="flex items-center ml-3 shrink-0">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              openRevertModal(version.commit);
                            }}
                            className="h-6 px-2 text-[11px] inline-flex items-center rounded-full hover:bg-muted"
                            title="Restore this version"
                          >
                            <span className="text-[11px]">Restore</span>
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="text-xs text-muted-foreground">
                      {new Date(version.date).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: new Date(version.date).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
                      })} at {new Date(version.date).toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                      })}
                    </div>
                  </div>
                </DropdownMenuItem>
              );
            })
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        onChange={processUpload}
        disabled={isUploading}
      />
    </>
  );

  // Library view layout
  if (isLibraryView) {
    const allFiles = selectedVersion ? versionFiles : files;
    // Split files into main outputs and other files
    const mainOutputFiles = allFiles.filter(file => isMainOutput(file, isPresentationFolder));
    const otherFiles = allFiles.filter(file => !isMainOutput(file, isPresentationFolder));
    
    return (
      <div className="flex flex-col min-h-screen bg-background">
        {/* Library Header */}
        <div className="px-8 pt-8 pb-6">
          <div className="flex items-center gap-4 mb-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={navigateHome}
              className="h-9 w-9"
            >
              {currentPath === '/workspace' ? (
                <ArrowLeft className="h-4 w-4" />
              ) : (
                <ArrowLeft className="h-4 w-4" />
              )}
            </Button>
            
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">
                {currentPath === '/workspace' ? 'Library' : currentPath.split('/').pop()}
              </h1>
              {currentPath !== '/workspace' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={navigateHome}
                  className="text-xs text-muted-foreground"
                >
                  <Home className="h-3 w-3 mr-1" />
                  Home
                </Button>
              )}
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-2">
              {libraryHeaderActions}
            </div>
          </div>

          {/* Breadcrumb for library view */}
          {currentPath !== '/workspace' && (
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <button onClick={navigateHome} className="hover:text-foreground">
                Files
              </button>
              {getBreadcrumbSegments(currentPath).map((segment) => (
                <span key={segment.path} className="flex items-center gap-1">
                  <ChevronRight className="h-3 w-3" />
                  <button
                    onClick={() => navigateToBreadcrumb(segment.path)}
                    className={cn(
                      "hover:text-foreground",
                      segment.isLast && "text-foreground font-medium"
                    )}
                  >
                    {segment.name}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Version viewing banner */}
        {selectedVersion && (
          <VersionBanner 
            versionDate={selectedVersionDate || undefined}
            onReturnToCurrent={() => loadFilesAtVersion(null)}
          />
        )}

        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {(isLoadingFiles || isLoadingVersionFiles) ? (
            <div className="flex-1 flex items-center justify-center">
              <KortixLoader size="medium" />
            </div>
          ) : mainOutputFiles.length === 0 && otherFiles.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
                <div className="w-14 h-14 flex items-center justify-center rounded-xl bg-muted/50">
                  <Folder className="h-6 w-6 text-muted-foreground" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-lg font-semibold">
                    {!hasSandbox ? 'Nothing here yet' : !isComputerStarted ? 'Waking up...' : 'No files yet'}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {!hasSandbox ? 'Your files will appear here once you start a conversation.' : 
                     !isComputerStarted ? 'Just a moment while things get ready.' :
                     'Start a conversation to create files.'}
                  </p>
                </div>
                {onNavigateToThread && (
                  <Button onClick={onNavigateToThread} size="sm" className="mt-2">
                    Go to Chat
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="px-8 pb-8">
                {/* Main outputs - large cards */}
                {mainOutputFiles.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {mainOutputFiles.map((file) => {
                      const isPresentation = isPresentationFolder(file);
                      return (
                        <div
                          key={file.path}
                          className="bg-card rounded-2xl border border-border overflow-hidden cursor-pointer group hover:border-border/80 transition-colors"
                          onClick={() => handleItemClick(file)}
                        >
                          {/* Header with icon, title and menu - thread icon style */}
                          <div className="flex items-center gap-3 p-4 border-b border-border/50">
                            <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                              {getFileIcon(file, 'header')}
                            </div>
                            <span className="flex-1 font-medium truncate text-sm">{file.name}</span>
                            {isPresentation && (
                              <Badge 
                                variant="secondary" 
                                className="text-[10px] px-1.5 py-0 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                              >
                                Slides
                              </Badge>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button 
                                  className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground opacity-0 group-hover:opacity-100"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleItemClick(file); }}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  {file.is_dir ? 'Open folder' : 'Open file'}
                                </DropdownMenuItem>
                                {!file.is_dir && (
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDownloadFile(file.path); }}>
                                    <Download className="mr-2 h-4 w-4" />
                                    Download
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          
                          {/* Preview - show thumbnail for images and presentations */}
                          <div className="w-full aspect-[16/10] relative overflow-hidden">
                            <ThumbnailPreview
                              file={file}
                              sandboxId={sandboxId}
                              project={project}
                              isPresentationFolder={isPresentation}
                              fallbackIcon={getFileIcon(file, 'large')}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Other files - collapsible section matching thread list style */}
                {otherFiles.length > 0 && (
                  <div className={cn("mt-8", mainOutputFiles.length === 0 && "mt-0")}>
                    <button
                      onClick={() => setShowOtherFiles(!showOtherFiles)}
                      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
                    >
                      <ChevronRight className={cn(
                        "h-4 w-4 transition-transform",
                        showOtherFiles && "rotate-90"
                      )} />
                      <span>Other files</span>
                    </button>
                    
                    {showOtherFiles && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-w-2xl">
                        {otherFiles.map((file) => (
                          <button
                            key={file.path}
                            className="flex items-center gap-3 p-2.5 rounded-2xl hover:bg-muted/50 transition-colors text-left group min-w-0"
                            onClick={() => handleItemClick(file)}
                          >
                            <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                              {getFileIcon(file, 'header')}
                            </div>
                            <span className="flex-1 text-sm text-muted-foreground group-hover:text-foreground truncate min-w-0">
                              {file.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </div>

        {/* Revert Modal */}
        <Dialog open={revertModalOpen} onOpenChange={setRevertModalOpen}>
          <DialogContent className="sm:max-w-md rounded-xl bg-background border border-border">
            <DialogHeader>
              <DialogTitle>Restore Previous Version</DialogTitle>
              <DialogDescription>
                This will restore all files from this version snapshot.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-950/20 border border-zinc-200 dark:border-zinc-800">
              <AlertTriangle className="h-4 w-4 text-zinc-600 dark:text-zinc-500 mt-0.5 shrink-0" />
              <span className="text-xs text-zinc-700 dark:text-zinc-400">This will replace current files with the selected version snapshot.</span>
            </div>
            {revertLoadingInfo ? (
              <div className="py-6 flex items-center justify-center"><KortixLoader size="medium" /></div>
            ) : revertCommitInfo ? (
              <div className="mt-2">
                <div className="text-sm font-medium mb-1">{revertCommitInfo.message}</div>
                <div className="text-xs text-muted-foreground mb-3">
                  {revertCommitInfo.date && new Date(revertCommitInfo.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
                <div className="text-xs text-muted-foreground mb-2">Files that will be affected:</div>
                <div className="max-h-40 overflow-y-auto mb-3 border rounded-2xl p-2">
                  {((revertCommitInfo.revert_files || []).length ? revertCommitInfo.revert_files : revertCommitInfo.files_in_commit || []).map((f: any) => (
                    <div key={f.path + (f.old_path || '')} className="flex items-center justify-between gap-2 py-1 px-1 rounded">
                      <div className="text-sm truncate max-w-[260px]">{f.path}</div>
                      <div className="text-xs text-muted-foreground">{f.status}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : <div className="py-4">No commit info</div>}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRevertModalOpen(false)} disabled={revertInProgress}>Cancel</Button>
              <Button onClick={performRevert} disabled={revertInProgress}>
                {revertInProgress ? (<><KortixLoader size="small" className="mr-2" />Restoring...</>) : 'Restore'}
              </Button>
            </DialogFooter>
            <DialogClose />
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Default side-panel layout (also handles inline-library variant)
  // For inline-library, split into main outputs and other files
  const allPanelFiles = selectedVersion ? versionFiles : files;
  const mainPanelFiles = isInlineLibrary 
    ? allPanelFiles.filter(file => isMainOutput(file, isPresentationFolder))
    : allPanelFiles;
  const otherPanelFiles = isInlineLibrary
    ? allPanelFiles.filter(file => !isMainOutput(file, isPresentationFolder))
    : [];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header with Breadcrumb Navigation */}
      <KortixComputerHeader
        icon={Home}
        onIconClick={navigateHome}
        iconTitle="Home"
        title={currentPath === '/workspace' ? (isInlineLibrary ? 'Library' : 'Files') : undefined}
        breadcrumbs={currentPath !== '/workspace' ? getBreadcrumbSegments(currentPath) : undefined}
        onBreadcrumbClick={navigateToBreadcrumb}
        actions={defaultHeaderActions}
      />

      {/* Version viewing banner */}
      {selectedVersion && (
        <VersionBanner 
          versionDate={selectedVersionDate || undefined}
          onReturnToCurrent={() => loadFilesAtVersion(null)}
        />
      )}

      {/* File Explorer */}
      <div className="flex-1 overflow-hidden max-w-full min-w-0">
        {(isLoadingFiles || isLoadingVersionFiles) ? (
          <div className="h-full w-full max-w-full flex flex-col items-center justify-center gap-2 min-w-0">
            <KortixLoader size="medium" />
            <p className="text-xs text-muted-foreground">
              {isLoadingVersionFiles ? 'Loading version...' : 'Loading files...'}
            </p>
            {!isLoadingVersionFiles && dirRetryAttempt > 0 && (
              <p className="text-xs text-muted-foreground">
                Retrying... (attempt {dirRetryAttempt + 1})
              </p>
            )}
          </div>
        ) : (mainPanelFiles.length === 0 && otherPanelFiles.length === 0) ? (
          <div className="h-full w-full flex flex-col items-center justify-center p-8 bg-zinc-50 dark:bg-zinc-900/50">
            <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
              <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center border-2 border-zinc-200 dark:border-zinc-700">
                <Folder className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
              </div>
              <div className="space-y-2">
                {!hasSandbox ? (
                  <>
                    <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                      {isInlineLibrary ? 'Nothing here yet' : 'Files not available'}
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      {isInlineLibrary 
                        ? 'Your files will appear here once you start a conversation.'
                        : 'A computer will be created when you start working on this task. Files will appear here once ready.'}
                    </p>
                  </>
                ) : !isComputerStarted ? (
                  <>
                    <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                      {isInlineLibrary ? 'Waking up...' : 'Computer starting...'}
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      {isInlineLibrary 
                        ? 'Just a moment while things get ready.'
                        : 'Files will appear once the computer is ready.'}
                    </p>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                      {isInlineLibrary ? 'No files yet' : 'Directory is empty'}
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      {isInlineLibrary 
                        ? 'Start a conversation to create files.'
                        : 'This folder doesn\'t contain any files yet.'}
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : isInlineLibrary ? (
          /* Inline Library: Card layout with thumbnails */
          <ScrollArea className="h-full w-full max-w-full min-w-0">
            <div className="p-4 max-w-full min-w-0">
              {/* Main outputs - large cards */}
              {mainPanelFiles.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-full min-w-0">
                  {mainPanelFiles.map((file) => {
                    const isPresentation = isPresentationFolder(file);
                    return (
                      <div
                        key={file.path}
                        className="bg-card rounded-2xl border border-border overflow-hidden cursor-pointer group hover:border-border/80 transition-colors"
                        onClick={() => handleItemClick(file)}
                      >
                        {/* Header with icon, title and action buttons */}
                        <div className="flex items-center gap-2.5 p-3 border-b border-border/50">
                          <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-card border border-border flex-shrink-0">
                            {getFileIcon(file, 'header')}
                          </div>
                          <span className="flex-1 font-medium truncate text-sm">{file.name}</span>
                          {isPresentation && (
                            <Badge 
                              variant="secondary" 
                              className="text-[10px] px-1.5 py-0 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
                            >
                              Slides
                            </Badge>
                          )}
                          
                          {/* Action buttons - visible on hover */}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {/* Open button */}
                            <button
                              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                              onClick={(e) => { e.stopPropagation(); handleItemClick(file); }}
                              title={file.is_dir ? 'Open folder' : 'Open file'}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                            
                            {/* Download button (for files only) */}
                            {!file.is_dir && (
                              <button
                                className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                                onClick={(e) => { e.stopPropagation(); handleDownloadFile(file.path); }}
                                title="Download"
                              >
                                <Download className="h-3.5 w-3.5" />
                              </button>
                            )}
                            
                            {/* More options dropdown */}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button 
                                  className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleItemClick(file); }}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  {file.is_dir ? 'Open folder' : 'Open file'}
                                </DropdownMenuItem>
                                {!file.is_dir && (
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDownloadFile(file.path); }}>
                                    <Download className="mr-2 h-4 w-4" />
                                    Download
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                        
                        {/* Thumbnail preview */}
                        <div className="w-full aspect-[16/10] relative overflow-hidden">
                          <ThumbnailPreview
                            file={file}
                            sandboxId={sandboxId}
                            project={project}
                            isPresentationFolder={isPresentation}
                            fallbackIcon={getFileIcon(file, 'large')}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Other files - collapsible section matching thread list style */}
              {otherPanelFiles.length > 0 && (
                <div className={cn("mt-6", mainPanelFiles.length === 0 && "mt-0")}>
                  <button
                    onClick={() => setShowOtherFiles(!showOtherFiles)}
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
                  >
                    <ChevronRight className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      showOtherFiles && "rotate-90"
                    )} />
                    <span>Other files</span>
                  </button>
                  
                  {showOtherFiles && (
                    <div className="grid grid-cols-2 gap-0.5">
                      {otherPanelFiles.map((file) => (
                        <button
                          key={file.path}
                          className="flex items-center gap-3 p-2.5 rounded-2xl hover:bg-muted/50 transition-colors text-left group min-w-0"
                          onClick={() => handleItemClick(file)}
                        >
                          <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-card border-[1.5px] border-border flex-shrink-0">
                            {getFileIcon(file, 'header')}
                          </div>
                          <span className="flex-1 text-sm text-muted-foreground group-hover:text-foreground truncate min-w-0">
                            {file.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          /* Default: Simple icon grid */
          <ScrollArea className="h-full w-full max-w-full p-2 min-w-0">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4 max-w-full min-w-0">
              {mainPanelFiles.map((file) => (
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
                      className="absolute top-1 right-1 text-[10px] px-1.5 py-0 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
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

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-linear-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4 shrink-0">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge variant="outline" className="py-0.5 h-6">
            <Folder className="h-3 w-3 mr-1" />
            {mainPanelFiles.length + otherPanelFiles.length} {(mainPanelFiles.length + otherPanelFiles.length) === 1 ? 'item' : 'items'}
          </Badge>
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-[200px]">
          {currentPath}
        </div>
      </div>

      {/* Revert Modal */}
      <Dialog open={revertModalOpen} onOpenChange={setRevertModalOpen}>
        <DialogContent className="sm:max-w-md rounded-xl bg-background border border-border">
          <DialogHeader>
            <DialogTitle>Restore Previous Version</DialogTitle>
            <DialogDescription>
              This will restore all files from this version snapshot.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-start gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-950/20 border border-zinc-200 dark:border-zinc-800">
            <AlertTriangle className="h-4 w-4 text-zinc-600 dark:text-zinc-500 mt-0.5 shrink-0" />
            <span className="text-xs text-zinc-700 dark:text-zinc-400">This will replace current files with the selected version snapshot. Your current changes will be overwritten.</span>
          </div>

          {revertLoadingInfo ? (
            <div className="py-6 flex items-center justify-center">
              <KortixLoader size="medium" />
            </div>
          ) : revertCommitInfo ? (
            <div className="mt-2">
              <div className="text-sm font-medium mb-1">{revertCommitInfo.message}</div>
              <div className="text-xs text-muted-foreground mb-3">
                {revertCommitInfo.date && new Date(revertCommitInfo.date).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric'
                })}
              </div>

              <div className="text-xs text-muted-foreground mb-2">Files that will be affected:</div>

              <div className="max-h-40 overflow-y-auto mb-3 border rounded-2xl p-2">
                {(() => {
                  const revertList = revertCommitInfo.revert_files || [];
                  const inCommitList = revertCommitInfo.files_in_commit || [];

                  return (revertList.length ? revertList : inCommitList).map((f: any) => {
                    const p = f.path;
                    const effect = f.revert_effect || f.revertEffect || 'unknown';
                    const effectLabel = effect === 'will_delete' ? 'Will delete' : effect === 'will_restore' ? 'Will restore' : effect === 'will_modify' ? 'Will modify' : 'Unknown';
                    return (
                      <div key={p + (f.old_path || '')} className="flex items-center justify-between gap-2 py-1 px-1 rounded">
                        <div className="flex flex-col min-w-0">
                          <div className="text-sm truncate max-w-[260px]">{p}</div>
                          {f.old_path && f.old_path !== p && (
                            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">Renamed from: {f.old_path}</div>
                          )}
                        </div>
                        <div className="flex flex-col items-end">
                          <div className="text-xs text-muted-foreground">{f.status}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{effectLabel}</div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          ) : (
            <div className="py-4">No commit info</div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevertModalOpen(false)} disabled={revertInProgress}>Cancel</Button>
            <Button onClick={performRevert} disabled={revertInProgress}>
              {revertInProgress ? (<><KortixLoader size="small" className="mr-2" />Restoring...</>) : 'Restore'}
            </Button>
          </DialogFooter>

          <DialogClose />
        </DialogContent>
      </Dialog>
    </div>
  );
}

