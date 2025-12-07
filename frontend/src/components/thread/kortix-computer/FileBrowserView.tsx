'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  File,
  Folder,
  Upload,
  Download,
  ChevronRight,
  Home,
  Loader,
  FileText,
  Presentation,
  ChevronDown,
  AlertTriangle,
} from 'lucide-react';
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
import { VersionBanner } from './VersionBanner';
import { KortixComputerHeader } from './KortixComputerHeader';

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
    selectedVersion,
    selectedVersionDate,
    setSelectedVersion,
    clearSelectedVersion,
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
          // Open presentation in viewer
          openFile(file.path);
        } else {
          // Navigate to folder (works in both current and version view)
          navigateToPath(file.path);
        }
      } else {
        // Open file in viewer (FileViewerView will detect selectedVersion from store)
        openFile(file.path);
      }
    },
    [navigateToPath, openFile, isPresentationFolder, selectedVersion],
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

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header with Breadcrumb Navigation */}
      <KortixComputerHeader
        icon={Home}
        onIconClick={navigateHome}
        iconTitle="Home"
        title={currentPath === '/workspace' ? 'Files' : undefined}
        breadcrumbs={currentPath !== '/workspace' ? getBreadcrumbSegments(currentPath) : undefined}
        onBreadcrumbClick={navigateToBreadcrumb}
        actions={
          <>
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
            variant="outline"
            size="sm"
            onClick={handleDownloadFolder}
            disabled={isDownloadingAll || isLoadingFiles}
            className="h-8 w-8 p-0 bg-transparent border border-border rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50"
            title="Download folder"
          >
            {isDownloadingAll ? (
              <Loader className="h-4 w-4 animate-spin" />
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
              <Loader className="h-4 w-4 animate-spin" />
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
                  <Loader className="h-3.5 w-3.5 animate-spin" />
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
                  <Loader className="h-5 w-5 animate-spin text-muted-foreground" />
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
        }
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
            <Loader className="h-6 w-6 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">
              {isLoadingVersionFiles ? 'Loading version...' : 'Loading files...'}
            </p>
            {!isLoadingVersionFiles && dirRetryAttempt > 0 && (
              <p className="text-xs text-muted-foreground">
                Retrying... (attempt {dirRetryAttempt + 1})
              </p>
            )}
          </div>
        ) : (selectedVersion ? versionFiles : files).length === 0 ? (
          <div className="h-full w-full flex flex-col items-center justify-center p-8 bg-zinc-50 dark:bg-zinc-900/50">
            <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
              <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center border-2 border-zinc-200 dark:border-zinc-700">
                <Folder className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
              </div>
              <div className="space-y-2">
                {!hasSandbox ? (
                  <>
                    <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                      Files not available
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      A computer will be created when you start working on this task. Files will appear here once ready.
                    </p>
                  </>
                ) : !isComputerStarted ? (
                  <>
                    <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                      Computer starting...
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      Files will appear once the computer is ready.
                    </p>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                      Directory is empty
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                      This folder doesn&apos;t contain any files yet.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full w-full max-w-full p-2 min-w-0">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4 max-w-full min-w-0">
              {(selectedVersion ? versionFiles : files).map((file) => (
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

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-linear-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4 shrink-0">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge variant="outline" className="py-0.5 h-6">
            <Folder className="h-3 w-3 mr-1" />
            {(selectedVersion ? versionFiles : files).length} {(selectedVersion ? versionFiles : files).length === 1 ? 'item' : 'items'}
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

          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/30">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-500 mt-0.5 shrink-0" />
            <span className="text-xs text-red-700 dark:text-red-400">This will replace current files with the selected version snapshot. Your current changes will be overwritten.</span>
          </div>

          {revertLoadingInfo ? (
            <div className="py-6 flex items-center justify-center">
              <Loader className="h-6 w-6 animate-spin" />
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
              {revertInProgress ? (<><Loader className="h-4 w-4 animate-spin mr-2" />Restoring...</>) : 'Restore'}
            </Button>
          </DialogFooter>

          <DialogClose />
        </DialogContent>
      </Dialog>
    </div>
  );
}

