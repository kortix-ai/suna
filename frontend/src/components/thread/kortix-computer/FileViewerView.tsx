'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  Loader,
  Loader2,
  AlertTriangle,
  Check,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Home,
  Save,
  AlertCircle,
  ChevronDown,
  FileText,
  Download,
} from 'lucide-react';
import {
  EditableFileRenderer,
  getEditableFileType,
  isEditableFileType,
  type MarkdownEditorControls,
} from '@/components/file-editors';
import { Project } from '@/lib/api/threads';
import { toast } from 'sonner';
import { useAuth } from '@/components/AuthProvider';
import {
  useFileContentQuery,
  FileCache
} from '@/hooks/files';
import { useDownloadRestriction } from '@/hooks/billing';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { PresentationViewer } from '../tool-views/presentation-tools/PresentationViewer';
import { FullScreenPresentationViewer } from '../tool-views/presentation-tools/FullScreenPresentationViewer';
import { usePresentationViewerStore } from '@/stores/presentation-viewer-store';
import { KortixComputerHeader } from './KortixComputerHeader';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useQueryClient } from '@tanstack/react-query';
import { fileQueryKeys } from '@/hooks/files/use-file-queries';
import { VersionBanner } from './VersionBanner';
import { FileDownloadButton } from '../tool-views/shared/FileDownloadButton';



// Define API_URL
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

/**
 * Normalize a file path to ensure it starts with /workspace
 * Handles paths like "workspace", "workspace/foo", "/workspace", "/workspace/foo", "/foo", "foo"
 */
function normalizeWorkspacePath(path: string): string {
  if (!path) return '/workspace';
  
  // Handle paths that start with "workspace" (without leading /)
  // This prevents "/workspace/workspace" when someone passes "workspace" or "workspace/foo"
  if (path === 'workspace' || path.startsWith('workspace/')) {
    return '/' + path;
  }
  
  // If already starts with /workspace, return as-is
  if (path.startsWith('/workspace')) {
    return path;
  }
  
  // Otherwise, prepend /workspace/
  return `/workspace/${path.replace(/^\//, '')}`;
}

// API Helper: Get file history (git commits)
async function fetchFileHistory(
  sandboxId: string,
  filePath: string,
  sessionToken?: string,
  limit: number = 100
): Promise<{ path: string; versions: Array<{ commit: string; author_name: string; author_email: string; date: string; message: string }> }> {
  const url = `${API_URL}/sandboxes/${sandboxId}/files/history?path=${encodeURIComponent(filePath)}&limit=${limit}`;
  const headers: Record<string, string> = {};
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch file history: ${response.statusText}`);
  }
  return response.json();
}

// API Helper: Get file content at specific commit
async function fetchFileByHash(
  sandboxId: string,
  filePath: string,
  commit: string,
  sessionToken?: string
): Promise<Blob> {
  const url = `${API_URL}/sandboxes/${sandboxId}/files/content-by-hash?path=${encodeURIComponent(filePath)}&commit=${encodeURIComponent(commit)}`;
  const headers: Record<string, string> = {};
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch file at commit ${commit}: ${response.statusText}`);
  }
  return response.blob();
}

interface FileViewerViewProps {
  sandboxId: string;
  filePath: string;
  project?: Project;
  projectId?: string;
}

export function FileViewerView({
  sandboxId,
  filePath,
  project,
}: FileViewerViewProps) {
  const { session } = useAuth();

  // Kortix Computer Store
  const {
    filePathList,
    currentFileIndex,
    setCurrentFileIndex,
    goBackToBrowser,
    setUnsavedContent,
    getUnsavedContent,
    clearUnsavedContent,
    setUnsavedState,
    getUnsavedState,
    selectedVersion: globalSelectedVersion,
    selectedVersionDate: globalSelectedVersionDate,
    setSelectedVersion: setGlobalSelectedVersion,
    clearSelectedVersion: clearGlobalSelectedVersion,
  } = useKortixComputerStore();

  // React Query client for cache invalidation
  const queryClient = useQueryClient();

  // Presentation viewer store for fullscreen
  const presentationViewerStore = usePresentationViewerStore();

  // Download restriction for free tier users
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'files',
  });

  // File content state
  const [rawContent, setRawContent] = useState<string | Blob | null>(null);
  const [textContentForRenderer, setTextContentForRenderer] = useState<string | null>(null);
  const [blobUrlForRenderer, setBlobUrlForRenderer] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  // Utility state
  const [isDownloading, setIsDownloading] = useState(false);
  const [mdEditorControls, setMdEditorControls] = useState<MarkdownEditorControls | null>(null);
  const activeDownloadUrls = useRef<Set<string>>(new Set());

  // Track previous sandboxId to detect thread switches
  const prevSandboxIdRef = useRef<string | null>(null);

  // Reset all local file state when sandboxId changes (thread switch)
  useEffect(() => {
    if (prevSandboxIdRef.current !== null && prevSandboxIdRef.current !== sandboxId) {
      // SandboxId changed - reset all file content state
      console.log('[FileViewerView] Thread switched, resetting file state');
      setRawContent(null);
      setTextContentForRenderer(null);
      setBlobUrlForRenderer(null);
      setContentError(null);
      setMdEditorControls(null);
    }
    prevSandboxIdRef.current = sandboxId;
  }, [sandboxId]);

  // File version history state
  const [fileVersions, setFileVersions] = useState<Array<{ commit: string; author_name: string; author_email: string; date: string; message: string }>>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [isLoadingVersionContent, setIsLoadingVersionContent] = useState(false);

  // Use global version from store (set by file browser) or allow local override
  const selectedVersion = globalSelectedVersion;
  const selectedVersionDate = globalSelectedVersionDate;

  // Revert modal state
  const [revertModalOpen, setRevertModalOpen] = useState(false);
  const [revertCommitInfo, setRevertCommitInfo] = useState<any | null>(null);
  const [revertLoadingInfo, setRevertLoadingInfo] = useState(false);
  const [revertInProgress, setRevertInProgress] = useState(false);
  const [revertCurrentRelativePath, setRevertCurrentRelativePath] = useState<string | null>(null);
  const [revertMode, setRevertMode] = useState<'commit' | 'single'>('single');
  const [revertSelectedPaths, setRevertSelectedPaths] = useState<string[]>([]);

  // Use the React Query hook for the selected file
  const {
    data: cachedFileContent,
    isLoading: isCachedFileLoading,
    error: cachedFileError,
    failureCount: fileRetryAttempt,
    refetch: refetchFile,
  } = useFileContentQuery(
    sandboxId,
    filePath,
    {
      enabled: !!filePath && !!sandboxId && !selectedVersion, // Disable when viewing a specific version
      staleTime: 5 * 60 * 1000,
    }
  );

  // File metadata
  const fileName = filePath.split('/').pop() || '';
  const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
  const fileType = getEditableFileType(fileName);
  const canEdit = isEditableFileType(fileType);

  // File type checks
  const isMarkdownFile = fileExtension === 'md' || fileExtension === 'markdown';
  const isHtmlFile = fileExtension === 'html' || fileExtension === 'htm';
  const isPresentationFolder = filePath.includes('/presentations/') && !filePath.endsWith('/presentations');

  // Multi-file navigation
  const hasMultipleFiles = filePathList && filePathList.length > 1;
  const canNavigatePrev = hasMultipleFiles && currentFileIndex > 0;
  const canNavigateNext = hasMultipleFiles && currentFileIndex < (filePathList?.length || 0) - 1;

  const navigatePrevious = useCallback(() => {
    if (canNavigatePrev) {
      setCurrentFileIndex(currentFileIndex - 1);
    }
  }, [canNavigatePrev, currentFileIndex, setCurrentFileIndex]);

  const navigateNext = useCallback(() => {
    if (canNavigateNext) {
      setCurrentFileIndex(currentFileIndex + 1);
    }
  }, [canNavigateNext, currentFileIndex, setCurrentFileIndex]);

  // Load file version history on demand (when dropdown opens or when needed for selected version)
  const loadVersionHistory = useCallback(async (force: boolean = false) => {
    if (!sandboxId || !filePath) return;
    if (fileVersions.length > 0 && !force) return; // already loaded
    setIsLoadingVersions(true);
    try {
      const data = await fetchFileHistory(sandboxId, filePath, session?.access_token, 200);
      setFileVersions(data.versions || []);

      // If there's a selected version, update the date in the global store
      if (selectedVersion && data.versions && data.versions.length > 0) {
        const versionInfo = data.versions.find(v => v.commit === selectedVersion);
        if (versionInfo && versionInfo.date !== selectedVersionDate) {
          setGlobalSelectedVersion(selectedVersion, versionInfo.date);
        }
      }

      console.log('[FileViewerView] Loaded file history', { count: (data.versions || []).length });
    } catch (error) {
      console.error('[FileViewerView] Failed to load history', error);
      toast.error('Failed to load history');
    } finally {
      setIsLoadingVersions(false);
    }
  }, [sandboxId, filePath, session?.access_token, fileVersions.length, selectedVersion, selectedVersionDate, setGlobalSelectedVersion]);

  // Auto-load version history if we have a selected version but no date
  useEffect(() => {
    if (selectedVersion && !selectedVersionDate && sandboxId && filePath && fileVersions.length === 0) {
      console.log('[FileViewerView] Auto-loading version history for selected version');
      loadVersionHistory(true);
    }
  }, [selectedVersion, selectedVersionDate, sandboxId, filePath, fileVersions.length, loadVersionHistory]);

  const loadFileByVersion = useCallback(async (commit: string) => {
    if (!commit || !sandboxId || !filePath) return;

    const versionDate = fileVersions.find(v => v.commit === commit)?.date;
    setGlobalSelectedVersion(commit, versionDate);
    setIsLoadingVersionContent(true);
    setContentError(null);
    try {
      // Normalize path for cache operations and clear legacy cache for this file
      const normalizedPath = normalizeWorkspacePath(filePath);
      ['text', 'blob', 'json'].forEach(contentType => {
        const cacheKey = `${sandboxId}:${normalizedPath}:${contentType}`;
        FileCache.delete(cacheKey);
        console.log('[FileViewerView] Deleted cache key:', cacheKey);
      });

      const blob = await fetchFileByHash(sandboxId, filePath, commit, session?.access_token);

      console.log('[FileViewerView] Fetched blob:', { size: blob.size, type: blob.type });

      // Convert blob to text or keep as blob depending on file type
      const isImageFile = FileCache.isImageFile(filePath);
      const isPdfFile = FileCache.isPdfFile(filePath);
      const extension = filePath.split('.').pop()?.toLowerCase();
      const isOfficeFile = ['xlsx', 'xls', 'docx', 'pptx', 'ppt'].includes(extension || '');
      const isBinaryFile = isImageFile || isPdfFile || isOfficeFile;

      setRawContent(blob);

      if (isBinaryFile) {
        const blobUrl = URL.createObjectURL(blob);
        setBlobUrlForRenderer(blobUrl);
        setTextContentForRenderer(null);
        console.log('[FileViewerView] Set binary content:', blobUrl);
      } else {
        const text = await blob.text();
        setTextContentForRenderer(text);
        setBlobUrlForRenderer(null);
        console.log('[FileViewerView] Set text content, length:', text.length, 'preview:', text.substring(0, 100));
      }

      const versionDate = fileVersions.find(v => v.commit === commit)?.date;
      if (versionDate) {
        toast.success(`Loaded version from ${new Date(versionDate).toLocaleDateString()}`);
      }
    } catch (error) {
      console.error('[FileViewerView] Error loading version:', error);
      setContentError(`Failed to load file version: ${error instanceof Error ? error.message : String(error)}`);
      toast.error(`Failed to load file version: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsLoadingVersionContent(false);
    }
  }, [filePath, sandboxId, session?.access_token, fileVersions, setGlobalSelectedVersion]);

  // Open revert modal and fetch commit info (files changed)
  const openRevertModal = useCallback(async (commit: string) => {
    if (!commit || !sandboxId) return;
    setRevertModalOpen(true);
    setRevertLoadingInfo(true);
    setRevertCommitInfo(null);
    try {
      const url = `${API_URL}/sandboxes/${sandboxId}/files/commit-info?commit=${encodeURIComponent(commit)}${filePath ? `&path=${encodeURIComponent(filePath)}` : ''}`;
      const res = await fetch(url, { headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {} });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to fetch commit info');
      }
      const data = await res.json();
      setRevertCommitInfo(data);

      // Normalize current file path relative to workspace and store for single-file revert
      const normalizedRelative = filePath ? (filePath.startsWith('/workspace') ? filePath.replace(/^\/workspace\//, '') : filePath.replace(/^\//, '')) : '';
      setRevertCurrentRelativePath(normalizedRelative || null);
      // default to single-file if the current file would be affected by reverting, otherwise default to commit
      // backend now returns `files_in_commit` (what changed in the commit) and `revert_files` (what revert would affect)
      const filesInCommit = (data.files_in_commit || []).map((f: any) => f.path);
      const revertFiles = (data.revert_files || []).map((f: any) => f.path);
      // prefer explicit flag if provided
      const shouldDefaultSingle = data.path_affected_on_revert === true || revertFiles.includes(normalizedRelative) || filesInCommit.includes(normalizedRelative);
      setRevertMode(shouldDefaultSingle ? 'single' : 'commit');
    } catch (error) {
      console.error('Failed to load commit info:', error);
      toast.error('Failed to load commit info');
      setRevertModalOpen(false);
    } finally {
      setRevertLoadingInfo(false);
    }
  }, [sandboxId, filePath, session?.access_token]);

  // NOTE: file-selection toggle removed — modal is read-only list with single-file or entire-commit mode

  const performRevert = useCallback(async () => {
    if (!revertCommitInfo || !sandboxId) return;
    setRevertInProgress(true);
    try {
      const body: any = { commit: revertCommitInfo.commit };
      // If user chose single-file revert, send only the current relative path
      if (revertMode === 'single' && revertCurrentRelativePath) {
        body.paths = [revertCurrentRelativePath];
      }

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
      console.log('[FileViewerView] Revert result', result);

      // Close modal first for better UX
      setRevertModalOpen(false);

      // Clear selected version to return to current
      clearGlobalSelectedVersion();

      // Clear version history to force reload next time
      setFileVersions([]);

      // Clear any unsaved content
      clearUnsavedContent(filePath);

      // Always clear caches and refetch after restore
      const normalizedPath = normalizeWorkspacePath(filePath);

      console.log('[FileViewerView] Clearing caches for path:', normalizedPath);

      // Clear legacy FileCache
      ['text', 'blob', 'json'].forEach(contentType => {
        const cacheKey = `${sandboxId}:${normalizedPath}:${contentType}`;
        FileCache.delete(cacheKey);
      });

      // Invalidate React Query cache
      ['text', 'blob', 'json'].forEach(contentType => {
        queryClient.invalidateQueries({
          queryKey: fileQueryKeys.content(sandboxId, normalizedPath, contentType),
        });
      });

      // Refetch the file to get the reverted content
      console.log('[FileViewerView] Refetching file after restore');
      await refetchFile();

      toast.success('Version restored successfully');
    } catch (error) {
      console.error('[FileViewerView] Revert error', error);
      toast.error(`Failed to restore version: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRevertInProgress(false);
    }
  }, [revertCommitInfo, revertMode, revertCurrentRelativePath, sandboxId, filePath, session?.access_token, refetchFile, queryClient, clearUnsavedContent, clearGlobalSelectedVersion]);

  // Track the last loaded version+path combo to prevent re-loading
  const lastLoadedRef = useRef<{ version: string | null, path: string | null }>({ version: null, path: null });

  // Effect to auto-load file at selected version when opened from file browser or when switching files
  useEffect(() => {
    if (selectedVersion && filePath && sandboxId) {
      // Only load if version+path combo has changed
      if (lastLoadedRef.current.version !== selectedVersion || lastLoadedRef.current.path !== filePath) {
        console.log('[FileViewerView] Auto-loading file at version:', selectedVersion, 'for path:', filePath);
        lastLoadedRef.current = { version: selectedVersion, path: filePath };
        // Clear current content
        setTextContentForRenderer(null);
        setBlobUrlForRenderer(null);
        setRawContent(null);
        setContentError(null);
        // Load the file at the selected version
        loadFileByVersion(selectedVersion);
      }
    } else if (!selectedVersion) {
      // Reset tracking when returning to current
      lastLoadedRef.current = { version: null, path: null };
    }
  }, [selectedVersion, filePath, sandboxId, loadFileByVersion]);

  // Effect to handle cached file content updates
  useEffect(() => {
    if (!filePath) return;

    // Skip this effect if we're viewing a specific version (handled by loadFileByVersion)
    if (selectedVersion) {
      console.log('[FileViewerView] Skipping effect - viewing version:', selectedVersion);
      return;
    }

    console.log('[FileViewerView] Effect running for current version:', {
      filePath,
      isCachedFileLoading,
      hasContent: cachedFileContent !== null,
      contentType: typeof cachedFileContent
    });

    // Handle errors
    if (cachedFileError && !isCachedFileLoading && fileRetryAttempt >= 15) {
      setContentError(`Failed to load file: ${cachedFileError.message}`);
      return;
    } else if (cachedFileError && isCachedFileLoading) {
      return;
    }

    // Check for unsaved content first - if it exists, use it instead of cached content
    const unsavedContent = getUnsavedContent(filePath);
    if (unsavedContent !== undefined && canEdit) {
      console.log('[FileViewerView] Using unsaved content');
      // Use unsaved content if available
      setTextContentForRenderer(unsavedContent);
      setRawContent(unsavedContent);
      setBlobUrlForRenderer(null);
      return;
    }

    // Handle successful content from cache/server
    if (cachedFileContent !== null && !isCachedFileLoading) {
      console.log('[FileViewerView] Setting content from cache/server:', {
        contentType: typeof cachedFileContent,
        isString: typeof cachedFileContent === 'string',
        isBlob: cachedFileContent instanceof Blob,
        preview: typeof cachedFileContent === 'string' ? cachedFileContent.substring(0, 100) : 'N/A'
      });
      const isImageFile = FileCache.isImageFile(filePath);
      const isPdfFile = FileCache.isPdfFile(filePath);
      const extension = filePath.split('.').pop()?.toLowerCase();
      const isOfficeFile = ['xlsx', 'xls', 'docx', 'pptx', 'ppt'].includes(extension || '');
      const isBinaryFile = isImageFile || isPdfFile || isOfficeFile;

      setRawContent(cachedFileContent);

      if (typeof cachedFileContent === 'string') {
        if (cachedFileContent.startsWith('blob:')) {
          setTextContentForRenderer(null);
          setBlobUrlForRenderer(cachedFileContent);
        } else if (isBinaryFile) {
          setTextContentForRenderer(null);
          setBlobUrlForRenderer(null);
          setContentError('Binary file received in incorrect format. Please try refreshing.');
        } else {
          setTextContentForRenderer(cachedFileContent);
          setBlobUrlForRenderer(null);
        }
      } else if (cachedFileContent instanceof Blob) {
        const url = URL.createObjectURL(cachedFileContent);
        setBlobUrlForRenderer(url);
        setTextContentForRenderer(null);
      } else if (typeof cachedFileContent === 'object') {
        const jsonString = JSON.stringify(cachedFileContent, null, 2);
        setTextContentForRenderer(jsonString);
        setBlobUrlForRenderer(null);
      } else {
        setTextContentForRenderer(null);
        setBlobUrlForRenderer(null);
        setContentError('Unknown content type received.');
      }
    }
  }, [filePath, cachedFileContent, isCachedFileLoading, cachedFileError, fileRetryAttempt, getUnsavedContent, canEdit, selectedVersion]);

  // Cleanup blob URLs
  useEffect(() => {
    const currentBlobUrl = blobUrlForRenderer;
    const currentActiveUrls = activeDownloadUrls.current;
    return () => {
      if (currentBlobUrl && !isDownloading && !currentActiveUrls.has(currentBlobUrl)) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [blobUrlForRenderer, isDownloading]);

  // Keyboard navigation
  useEffect(() => {
    if (!hasMultipleFiles) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't interfere with editor keyboard shortcuts
      const target = e.target as HTMLElement;
      const isInEditor = target.closest('.cm-editor') || target.closest('.ProseMirror');
      if (isInEditor) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigatePrevious();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateNext();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [hasMultipleFiles, navigatePrevious, navigateNext]);

  // Handle file save
  const handleSaveFile = useCallback(async (newContent: string) => {
    if (!filePath || !sandboxId) {
      throw new Error('Missing file path or sandbox ID');
    }

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${session?.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: filePath,
            content: newContent,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Failed to save file');
      }

      // Normalize path for cache operations
      const normalizedPath = normalizeWorkspacePath(filePath);

      // Clear unsaved content from store
      clearUnsavedContent(filePath);

      // Invalidate React Query cache for all content types
      ['text', 'blob', 'json'].forEach(contentType => {
        queryClient.invalidateQueries({
          queryKey: fileQueryKeys.content(sandboxId, normalizedPath, contentType),
        });
      });

      // Also invalidate legacy FileCache
      const contentType = FileCache.getContentTypeFromPath(normalizedPath);
      const cacheKey = `${sandboxId}:${normalizedPath}:${contentType}`;
      FileCache.delete(cacheKey);

      // Refetch file to ensure fresh data
      await refetchFile();

      // Update local state
      setTextContentForRenderer(newContent);
      setRawContent(newContent);

      console.log('File saved successfully:', filePath);
    } catch (error) {
      console.error('Save error:', error);
      toast.error(`Failed to save: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }, [filePath, sandboxId, session?.access_token, clearUnsavedContent, queryClient, refetchFile]);

  // Handle file download
  const handleDownload = async () => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!filePath || isDownloading) return;

    try {
      setIsDownloading(true);

      const mimeType = FileCache.getMimeTypeFromPath?.(filePath) || 'application/octet-stream';

      if (rawContent) {
        let blob: Blob;

        if (typeof rawContent === 'string') {
          if (rawContent.startsWith('blob:')) {
            if (!sandboxId || sandboxId.trim() === '') {
              toast.error('Computer is not started yet.');
              return;
            }
            const response = await fetch(
              `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`,
              { headers: { 'Authorization': `Bearer ${session?.access_token}` } }
            );

            if (!response.ok) throw new Error(`Server error: ${response.status}`);
            blob = await response.blob();
          } else {
            blob = new Blob([rawContent], { type: mimeType });
          }
        } else if (rawContent instanceof Blob) {
          blob = rawContent;
        } else {
          blob = new Blob([JSON.stringify(rawContent)], { type: 'application/json' });
        }

        if (blob.type !== mimeType) {
          blob = new Blob([blob], { type: mimeType });
        }

        downloadBlob(blob, fileName);
        return;
      }

      if (!sandboxId || sandboxId.trim() === '') {
        toast.error('Computer is not started yet.');
        return;
      }
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`,
        { headers: { 'Authorization': `Bearer ${session?.access_token}` } }
      );

      if (!response.ok) throw new Error(`Server error: ${response.status}`);

      const blob = await response.blob();
      const finalBlob = new Blob([blob], { type: mimeType });
      downloadBlob(finalBlob, fileName);

    } catch (error) {
      toast.error(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsDownloading(false);
    }
  };

  // Helper function to download a blob
  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    activeDownloadUrls.current.add(url);
    setTimeout(() => {
      URL.revokeObjectURL(url);
      activeDownloadUrls.current.delete(url);
    }, 10000);

    toast.success('Download started');
  };

  // Handle fullscreen for presentations
  const handleOpenPresentationFullscreen = useCallback(() => {
    if (!project?.sandbox?.sandbox_url) return;

    // Extract presentation name from path
    const pathParts = filePath.split('/');
    const presentationsIndex = pathParts.indexOf('presentations');
    if (presentationsIndex >= 0 && presentationsIndex < pathParts.length - 1) {
      const presentationName = pathParts[presentationsIndex + 1];
      presentationViewerStore.openPresentation(presentationName, project.sandbox.sandbox_url, 1);
    }
  }, [filePath, project?.sandbox?.sandbox_url, presentationViewerStore]);

  // Render presentation viewer for presentation folders
  if (isPresentationFolder) {
    // Extract presentation name from path
    const pathParts = filePath.split('/');
    const presentationsIndex = pathParts.indexOf('presentations');
    const presentationName = presentationsIndex >= 0 && presentationsIndex < pathParts.length - 1
      ? pathParts[presentationsIndex + 1]
      : '';

    return (
      <div className="h-full flex flex-col overflow-hidden">
        {/* Header */}
        <KortixComputerHeader
          icon={Home}
          onIconClick={goBackToBrowser}
          iconTitle="Back to files"
          fileName={presentationName}
          actions={
            <>
              {hasMultipleFiles && (
                <div className="flex items-center gap-1 mr-1">
                  <button
                    onClick={navigatePrevious}
                    disabled={!canNavigatePrev}
                    className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Previous file (←)"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[10px] text-muted-foreground tabular-nums min-w-[32px] text-center">
                    {currentFileIndex + 1}/{filePathList?.length || 0}
                  </span>
                  <button
                    onClick={navigateNext}
                    disabled={!canNavigateNext}
                    className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Next file (→)"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenPresentationFullscreen}
                className="h-7 w-7 p-0"
                title="Open fullscreen"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </>
          }
        />

        {/* Presentation content - use a mock tool call for PresentationViewer */}
        <div className="flex-1 overflow-hidden max-w-full min-w-0">
          <PresentationViewer
            toolCall={{
              tool_call_id: `file-viewer-${presentationName}`,
              function_name: 'sb_presentation_create_update_slide',
              arguments: {},
              source: 'native',
            }}
            toolResult={{
              success: true,
              output: {
                presentation_name: presentationName,
                presentation_path: filePath,
              },
            }}
            isSuccess={true}
            isStreaming={false}
            project={project}
            showHeader={false}
          />
        </div>

        {/* Footer */}
        <div className="px-4 py-2 h-10 bg-linear-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4 shrink-0">
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Badge variant="outline" className="py-0.5 h-6">
              <FileText className="h-3 w-3 mr-1" />
              PRESENTATION
            </Badge>
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {filePath}
          </div>
        </div>

        {/* Fullscreen presentation viewer */}
        <FullScreenPresentationViewer
          isOpen={presentationViewerStore.isOpen}
          onClose={presentationViewerStore.closePresentation}
          presentationName={presentationViewerStore.presentationName}
          sandboxUrl={presentationViewerStore.sandboxUrl}
          initialSlide={presentationViewerStore.initialSlide}
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <KortixComputerHeader
        icon={Home}
        onIconClick={goBackToBrowser}
        iconTitle="Back to files"
        fileName={fileName}
        actions={
          <>
          {/* File navigation for multiple files */}
          {hasMultipleFiles && (
            <div className="flex items-center gap-1 mr-1">
              <button
                onClick={navigatePrevious}
                disabled={!canNavigatePrev}
                className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Previous file (←)"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] text-muted-foreground tabular-nums min-w-[32px] text-center">
                {currentFileIndex + 1}/{filePathList?.length || 0}
              </span>
              <button
                onClick={navigateNext}
                disabled={!canNavigateNext}
                className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Next file (→)"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* For markdown files with editor: Save + Export */}
          {isMarkdownFile && mdEditorControls && (
            <TooltipProvider delayDuration={300}>
              <>
                {/* Save Button */}
                {mdEditorControls.saveState === 'saving' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled
                    className="h-8 w-8 p-0 bg-transparent border border-border rounded-xl text-muted-foreground"
                    title="Saving..."
                  >
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </Button>
                ) : mdEditorControls.saveState === 'saved' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled
                    className="h-8 w-8 p-0 bg-transparent border border-green-500/20 rounded-xl text-green-600"
                    title="Saved"
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                ) : mdEditorControls.saveState === 'error' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={mdEditorControls.save}
                    className="h-8 w-8 p-0 bg-transparent border border-red-500/20 rounded-xl text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20"
                    title="Retry save"
                  >
                    <AlertCircle className="h-4 w-4" />
                  </Button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={mdEditorControls.save}
                        disabled={!mdEditorControls.hasChanges}
                        className="h-8 w-8 p-0 bg-transparent border border-border rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50"
                        title="Save file"
                      >
                        <Save className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {mdEditorControls.hasChanges ? (
                        <>Save changes <kbd className="ml-1.5 px-1 py-0.5 text-[10px] bg-muted rounded font-mono">⌘S</kbd></>
                      ) : (
                        'No changes to save'
                      )}
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Export Dropdown - uses shared FileDownloadButton component */}
                <FileDownloadButton
                  content={typeof rawContent === 'string' ? rawContent : ''}
                  fileName={fileName}
                  getHtmlContent={mdEditorControls?.getHtml ? () => mdEditorControls.getHtml() : undefined}
                />
              </>
            </TooltipProvider>
          )}

          <div className="flex-1" />

          {/* Version history dropdown */}
          <DropdownMenu onOpenChange={(open) => { if (open) loadVersionHistory(false); }}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={isCachedFileLoading}
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
              ) : fileVersions.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <span className="text-sm text-muted-foreground">No history available</span>
                </div>
              ) : (
                fileVersions.map((version, index) => {
                  const isCurrent = index === 0;
                  const isSelected = isCurrent ? !selectedVersion : selectedVersion === version.commit;
                  const parts = (version.message || '').split(':');
                  console.log('[FileViewerView] history item parts', { commit: version.commit, parts });

                  return (
                    <DropdownMenuItem
                      key={version.commit}
                      onClick={() => {
                        if (isCurrent) {
                          // Return to current: clear unsaved & cache, then refetch
                          clearGlobalSelectedVersion();
                          setContentError(null);
                          setIsLoadingVersionContent(true);
                          clearUnsavedContent(filePath);

                          const normalizedPath = normalizeWorkspacePath(filePath);

                          ['text', 'blob', 'json'].forEach(contentType => {
                            const cacheKey = `${sandboxId}:${normalizedPath}:${contentType}`;
                            FileCache.delete(cacheKey);
                          });

                          refetchFile().finally(() => setIsLoadingVersionContent(false));
                        } else {
                          loadFileByVersion(version.commit);
                        }
                      }}
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

                          <div className="flex items-center ml-3 shrink-0">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!isCurrent) openRevertModal(version.commit);
                              }}
                              className={cn(
                                'h-6 px-2 text-[11px] inline-flex items-center gap-0.5 rounded-full',
                                isCurrent ? 'opacity-90 cursor-default' : 'hover:bg-muted'
                              )}
                              disabled={isCurrent}
                              title={isCurrent ? 'Current version' : 'Restore this version'}
                            >
                              {isCurrent ? (
                                <span className="px-1">Current</span>
                              ) : (
                                <>
                                  <span className="text-[11px]">Restore</span>
                                </>
                              )}
                            </Button>
                          </div>
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

          {/* Download button - for non-markdown files */}
          {!isMarkdownFile && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              disabled={isDownloading || isCachedFileLoading}
              className="h-8 w-8 p-0 bg-transparent border border-border rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50"
              title="Download file"
            >
              {isDownloading ? (
                <Loader className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </Button>
          )}
          </>
        }
      />

      {/* Version viewing banner */}
      {selectedVersion && (
        <VersionBanner
          versionDate={selectedVersionDate || undefined}
          onReturnToCurrent={() => {
            // Return to current version
            clearGlobalSelectedVersion();
            setContentError(null);
            setIsLoadingVersionContent(true);
            clearUnsavedContent(filePath);

            const normalizedPath = normalizeWorkspacePath(filePath);

            ['text', 'blob', 'json'].forEach(contentType => {
              const cacheKey = `${sandboxId}:${normalizedPath}:${contentType}`;
              FileCache.delete(cacheKey);
            });

            refetchFile().finally(() => setIsLoadingVersionContent(false));
          }}
        />
      )}

      {/* File content */}
      <div className="flex-1 overflow-hidden max-w-full min-w-0">
        {(isCachedFileLoading || isLoadingVersionContent) ? (
          <div className="h-full w-full max-w-full flex flex-col items-center justify-center min-w-0">
            <Loader className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-sm text-muted-foreground">
              {isLoadingVersionContent ? 'Loading version...' : `Loading ${fileName}`}
            </p>
            {!isLoadingVersionContent && fileRetryAttempt > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                Retrying... (attempt {fileRetryAttempt + 1})
              </p>
            )}
          </div>
        ) : contentError ? (
          <div className="h-full w-full flex items-center justify-center p-4">
            <div className="max-w-md p-6 text-center border rounded-lg bg-muted/10">
              <AlertTriangle className="h-10 w-10 text-orange-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">Error Loading File</h3>
              <p className="text-sm text-muted-foreground mb-4">{contentError}</p>
              <div className="flex justify-center gap-3">
                <Button
                  onClick={() => {
                    setContentError(null);
                    // Trigger refetch by clearing cache
                    const normalizedPath = normalizeWorkspacePath(filePath);
                    const contentType = FileCache.getContentTypeFromPath(normalizedPath);
                    const cacheKey = `${sandboxId}:${normalizedPath}:${contentType}`;
                    FileCache.delete(cacheKey);
                    refetchFile();
                  }}
                >
                  Retry
                </Button>
                <Button variant="outline" onClick={goBackToBrowser}>
                  Back to Files
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full w-full max-w-full overflow-hidden min-w-0" style={{ contain: 'strict' }}>
            {(() => {
              const isImageFile = FileCache.isImageFile(filePath);
              const isPdfFile = FileCache.isPdfFile(filePath);
              const extension = filePath.split('.').pop()?.toLowerCase();
              const isOfficeFile = ['xlsx', 'xls', 'docx', 'pptx', 'ppt'].includes(extension || '');
              const isBinaryFile = isImageFile || isPdfFile || isOfficeFile;

              if (isBinaryFile && !blobUrlForRenderer) {
                return (
                  <div className="h-full w-full flex items-center justify-center">
                    <div className="text-sm text-muted-foreground">
                      Loading {isPdfFile ? 'PDF' : isImageFile ? 'image' : 'file'}...
                    </div>
                  </div>
                );
              }

              // Get original content - must be a plain text string (not blob URL, not Blob object)
              const originalTextContent = typeof cachedFileContent === 'string' && !cachedFileContent.startsWith('blob:')
                ? cachedFileContent
                : undefined;

              return (
                <EditableFileRenderer
                  key={filePath}
                  content={isBinaryFile ? null : textContentForRenderer}
                  originalContent={isBinaryFile ? undefined : originalTextContent}
                  hasUnsavedChanges={getUnsavedState(filePath)}
                  onUnsavedChange={(hasUnsaved) => {
                    if (canEdit && filePath && !selectedVersion) {
                      setUnsavedState(filePath, hasUnsaved);
                    }
                  }}
                  binaryUrl={blobUrlForRenderer}
                  fileName={fileName}
                  filePath={filePath}
                  className="h-full w-full max-w-full min-w-0"
                  project={project}
                  readOnly={!!selectedVersion}
                  onSave={canEdit && !selectedVersion ? handleSaveFile : undefined}
                  onDiscard={() => {
                    // Clear unsaved content when user discards
                    if (filePath) {
                      clearUnsavedContent(filePath);
                      // Reset to cached content
                      if (typeof cachedFileContent === 'string') {
                        setTextContentForRenderer(cachedFileContent);
                        setRawContent(cachedFileContent);
                      }
                    }
                  }}
                  onDownload={handleDownload}
                  isDownloading={isDownloading}
                  hideMarkdownToolbarActions={isMarkdownFile}
                  onMarkdownEditorReady={isMarkdownFile ? setMdEditorControls : undefined}
                  onChange={(content) => {
                    // Persist unsaved content to store (only if not viewing a version)
                    if (canEdit && filePath && !selectedVersion) {
                      setUnsavedContent(filePath, content);
                    }
                  }}
                />
              );
            })()}
          </div>
        )}
      </div>

      <Dialog open={revertModalOpen} onOpenChange={setRevertModalOpen}>
        <DialogContent className="sm:max-w-md rounded-xl bg-background border border-border">
          <DialogHeader>
            <DialogTitle>Restore Previous Version</DialogTitle>
            <DialogDescription>
              Choose to restore just this file or all files from this version snapshot.
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

              <div className="mb-3">
                <div className="flex gap-2">
                  <Button
                    variant={revertMode === 'single' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setRevertMode('single')}
                  >
                    Just this file
                  </Button>
                  <Button
                    variant={revertMode === 'commit' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setRevertMode('commit')}
                  >
                    Entire version snapshot
                  </Button>
                </div>
              </div>

              <div className="max-h-40 overflow-y-auto mb-3 border rounded-2xl p-2">
                {(() => {
                  const currentRel = revertCurrentRelativePath || (filePath.startsWith('/workspace') ? filePath.replace(/^\/workspace\//, '') : filePath.replace(/^\//, ''));
                  const revertList = revertCommitInfo.revert_files || [];
                  const inCommitList = revertCommitInfo.files_in_commit || [];

                  if (revertMode === 'single') {
                    // Find matching metadata for the current file in revert_files or files_in_commit
                    const match = revertList.find((x: any) => x.path === currentRel) || inCommitList.find((x: any) => x.path === currentRel);
                    const f = match || { path: currentRel, status: 'M', old_path: null, revert_effect: 'will_modify' };
                    const effect = f.revert_effect || f.revertEffect || 'unknown';
                    const effectLabel = effect === 'will_delete' ? 'Will delete' : effect === 'will_restore' ? 'Will restore' : effect === 'will_modify' ? 'Will modify' : 'Unknown';

                    return (
                      <div key={f.path + (f.old_path || '')} className="flex items-center justify-between gap-2 py-1 px-1 rounded">
                        <div className="flex flex-col min-w-0">
                          <div className="text-sm truncate max-w-[260px]">{f.path}</div>
                          {f.old_path && f.old_path !== f.path && (
                            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">Renamed from: {f.old_path}</div>
                          )}
                        </div>
                        <div className="flex flex-col items-end">
                          <div className="text-xs text-muted-foreground">{f.status}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{effectLabel}</div>
                        </div>
                      </div>
                    );
                  }

                  // commit mode: show all revert_files
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
            <Button onClick={performRevert} disabled={revertInProgress || (revertMode === 'single' && !revertCurrentRelativePath)}>
              {revertInProgress ? (<><Loader className="h-4 w-4 animate-spin mr-2" />Restoring...</>) : 'Restore'}
            </Button>
          </DialogFooter>

          <DialogClose />
        </DialogContent>
      </Dialog>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-linear-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4 shrink-0">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge variant="outline" className="py-0.5 h-6">
            <FileText className="h-3 w-3 mr-1" />
            {fileExtension.toUpperCase() || 'FILE'}
          </Badge>
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-[200px]">
          {filePath}
        </div>
      </div>
    </div>
  );
}

