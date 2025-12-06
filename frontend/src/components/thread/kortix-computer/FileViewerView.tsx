'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  Download,
  Loader,
  Loader2,
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  FileText,
  FileType,
  FileCode,
  Home,
  Save,
  AlertCircle,
} from 'lucide-react';
import {
  EditableFileRenderer,
  getEditableFileType,
  isEditableFileType,
  type MarkdownEditorControls,
} from '@/components/file-editors';
import { exportDocument, type ExportFormat } from '@/lib/utils/document-export';
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
import { Badge } from '@/components/ui/badge';
import { useQueryClient } from '@tanstack/react-query';
import { fileQueryKeys } from '@/hooks/files/use-file-queries';

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
  const [isExporting, setIsExporting] = useState(false);
  const [mdEditorControls, setMdEditorControls] = useState<MarkdownEditorControls | null>(null);
  const activeDownloadUrls = useRef<Set<string>>(new Set());

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
      enabled: !!filePath && !!sandboxId,
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

  // Effect to handle cached file content updates
  useEffect(() => {
    if (!filePath) return;

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
      // Use unsaved content if available
      setTextContentForRenderer(unsavedContent);
      setRawContent(unsavedContent);
      setBlobUrlForRenderer(null);
      return;
    }

    // Handle successful content from cache/server
    if (cachedFileContent !== null && !isCachedFileLoading) {
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
  }, [filePath, cachedFileContent, isCachedFileLoading, cachedFileError, fileRetryAttempt, getUnsavedContent, canEdit]);

  // Cleanup blob URLs
  useEffect(() => {
    return () => {
      if (blobUrlForRenderer && !isDownloading && !activeDownloadUrls.current.has(blobUrlForRenderer)) {
        URL.revokeObjectURL(blobUrlForRenderer);
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

  // Handle markdown export
  const handleMarkdownExport = useCallback(async (format: ExportFormat) => {
    if (!mdEditorControls) return;
    
    setIsExporting(true);
    try {
      const content = mdEditorControls.getHtml();
      await exportDocument({
        content,
        fileName: fileName.replace(/\.(md|markdown)$/i, ''),
        format,
      });
    } catch (error) {
      console.error('Export error:', error);
    } finally {
      setIsExporting(false);
    }
  }, [mdEditorControls, fileName]);

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
      const normalizedPath = filePath.startsWith('/workspace')
        ? filePath
        : `/workspace/${filePath.replace(/^\//, '')}`;
      
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
      <div className="flex flex-col h-full max-w-full overflow-hidden min-w-0 border-t border-zinc-200 dark:border-zinc-800">
        {/* Header */}
        <div className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 flex items-center justify-between flex-shrink-0 max-w-full min-w-0">
          {/* Left: Home + Name */}
          <div className="flex items-center gap-3 min-w-0 flex-1 max-w-full">
            <button
              onClick={goBackToBrowser}
              className="relative p-2 rounded-lg border flex-shrink-0 bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 border-zinc-200 dark:border-zinc-700 hover:from-zinc-200 hover:to-zinc-100 dark:hover:from-zinc-700 dark:hover:to-zinc-800 transition-all"
              title="Back to files"
            >
              <Home className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
            </button>
            
            <span className="text-base font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {presentationName}
            </span>
          </div>
          
          {/* Right: Actions */}
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
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
          </div>
        </div>

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
        <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4 flex-shrink-0">
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
    <div className="flex flex-col h-full max-w-full overflow-hidden min-w-0 border-t border-zinc-200 dark:border-zinc-800">
      {/* Header */}
      <div className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 flex items-center justify-between flex-shrink-0 max-w-full min-w-0">
        {/* Left: Home + Filename */}
        <div className="flex items-center gap-3 min-w-0 flex-1 max-w-full">
          <button
            onClick={goBackToBrowser}
            className="relative p-2 rounded-lg border flex-shrink-0 bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 border-zinc-200 dark:border-zinc-700 hover:from-zinc-200 hover:to-zinc-100 dark:hover:from-zinc-700 dark:hover:to-zinc-800 transition-all"
            title="Back to files"
          >
            <Home className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
          </button>
          
          <span className="text-base font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {fileName}
          </span>
        </div>
        
        {/* Right: Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
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
                <Button variant="ghost" size="sm" disabled className="h-7 px-2 gap-1.5 text-xs">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span className="hidden sm:inline">Saving</span>
                </Button>
              ) : mdEditorControls.saveState === 'saved' ? (
                <Button variant="ghost" size="sm" disabled className="h-7 px-2 gap-1.5 text-xs text-green-600">
                    <Check className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Saved</span>
                </Button>
              ) : mdEditorControls.saveState === 'error' ? (
                <Button variant="ghost" size="sm" onClick={mdEditorControls.save} className="h-7 px-2 gap-1.5 text-xs text-red-500 hover:text-red-600 hover:bg-red-50">
                    <AlertCircle className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Retry</span>
                </Button>
              ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={mdEditorControls.save} 
                        disabled={!mdEditorControls.hasChanges}
                        className="h-7 px-2 gap-1.5 text-xs"
                      >
                        <Save className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Save</span>
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

              {/* Export Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 px-2 gap-1.5 text-xs" disabled={isExporting}>
                    {isExporting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Download className="h-3.5 w-3.5" />
                    )}
                      <span className="hidden sm:inline">Export</span>
                  </Button>
                </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleMarkdownExport('pdf')}>
                      <FileType className="h-4 w-4 text-muted-foreground" />
                    PDF
                  </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleMarkdownExport('docx')}>
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    Word
                  </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleMarkdownExport('html')}>
                      <FileCode className="h-4 w-4 text-muted-foreground" />
                    HTML
                  </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleMarkdownExport('markdown')}>
                      <FileCode className="h-4 w-4 text-muted-foreground" />
                    Markdown
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
            </TooltipProvider>
          )}

          {/* Download button - for non-markdown files */}
          {!isMarkdownFile && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              disabled={isDownloading || isCachedFileLoading}
              className="h-7 px-2 gap-1.5 text-xs"
            >
              {isDownloading ? (
                <Loader className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              Download
            </Button>
          )}
        </div>
      </div>

      {/* File content */}
      <div className="flex-1 overflow-hidden max-w-full min-w-0">
        {isCachedFileLoading ? (
          <div className="h-full w-full max-w-full flex flex-col items-center justify-center min-w-0">
            <Loader className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-sm text-muted-foreground">
              Loading {fileName}
            </p>
            {fileRetryAttempt > 0 && (
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
                    const normalizedPath = filePath.startsWith('/workspace')
                      ? filePath
                      : `/workspace/${filePath.replace(/^\//, '')}`;
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
                    if (canEdit && filePath) {
                      setUnsavedState(filePath, hasUnsaved);
                    }
                  }}
                  binaryUrl={blobUrlForRenderer}
                  fileName={fileName}
                  filePath={filePath}
                  className="h-full w-full max-w-full min-w-0"
                  project={project}
                  readOnly={false}
                  onSave={canEdit ? handleSaveFile : undefined}
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
                    // Persist unsaved content to store
                    if (canEdit && filePath) {
                      setUnsavedContent(filePath, content);
                    }
                  }}
                />
              );
            })()}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4 flex-shrink-0">
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
