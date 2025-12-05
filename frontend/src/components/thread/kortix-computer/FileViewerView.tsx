'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  Download,
  Loader,
  AlertTriangle,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Maximize2,
  FileText,
  ArrowLeft,
} from 'lucide-react';
import {
  EditableFileRenderer,
  getEditableFileType,
  isEditableFileType,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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
  } = useKortixComputerStore();
  
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
  const [isCopyingContent, setIsCopyingContent] = useState(false);
  const markdownRef = useRef<HTMLDivElement>(null);
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

    // Handle successful content
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
  }, [filePath, cachedFileContent, isCachedFileLoading, cachedFileError, fileRetryAttempt]);

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

  // Copy to clipboard
  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      return false;
    }
  }, []);

  const handleCopyContent = useCallback(async () => {
    if (!textContentForRenderer) return;
    
    setIsCopyingContent(true);
    const success = await copyToClipboard(textContentForRenderer);
    if (success) {
      toast.success('File content copied to clipboard');
    } else {
      toast.error('Failed to copy file content');
    }
    setTimeout(() => setIsCopyingContent(false), 500);
  }, [textContentForRenderer, copyToClipboard]);

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

      // Invalidate cache after save
      const normalizedPath = filePath.startsWith('/workspace')
        ? filePath
        : `/workspace/${filePath.replace(/^\//, '')}`;
      const contentType = FileCache.getContentTypeFromPath(normalizedPath);
      const cacheKey = `${sandboxId}:${normalizedPath}:${contentType}`;
      FileCache.delete(cacheKey);

      // Update local state
      setTextContentForRenderer(newContent);
      setRawContent(newContent);

      console.log('File saved successfully:', filePath);
    } catch (error) {
      console.error('Save error:', error);
      toast.error(`Failed to save: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }, [filePath, sandboxId, session?.access_token]);

  // Handle PDF export for markdown files
  const handleExportPdf = useCallback(
    async (orientation: 'portrait' | 'landscape' = 'portrait') => {
      if (isDownloadRestricted) {
        openUpgradeModal();
        return;
      }
      if (!filePath || !isMarkdownFile) return;

      try {
        if (!markdownRef.current) {
          throw new Error('Markdown content not found');
        }

        const printWindow = window.open('', '_blank');
        if (!printWindow) {
          throw new Error('Unable to open print window. Please check if popup blocker is enabled.');
        }

        const pdfName = fileName.replace(/\.md$/, '');
        const markdownContent = markdownRef.current.innerHTML;

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>${pdfName}</title>
          <style>
            @media print {
              @page { 
                size: ${orientation === 'landscape' ? 'A4 landscape' : 'A4'};
                margin: 15mm;
              }
              body {
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }
            }
            body {
              font-family: 'Helvetica', 'Arial', sans-serif;
              font-size: 12pt;
              color: #333;
              line-height: 1.5;
              padding: 20px;
              max-width: 100%;
              margin: 0 auto;
              background: white;
            }
            h1 { font-size: 24pt; margin-top: 20pt; margin-bottom: 12pt; }
            h2 { font-size: 20pt; margin-top: 18pt; margin-bottom: 10pt; }
            h3 { font-size: 16pt; margin-top: 16pt; margin-bottom: 8pt; }
            p { margin: 8pt 0; }
            pre, code {
              font-family: 'Courier New', monospace;
              background-color: #f5f5f5;
              border-radius: 3pt;
              padding: 2pt 4pt;
              font-size: 10pt;
            }
            pre { padding: 8pt; margin: 8pt 0; overflow-x: auto; white-space: pre-wrap; }
            img { max-width: 100%; height: auto; }
            a { color: #0066cc; text-decoration: underline; }
            ul, ol { padding-left: 20pt; margin: 8pt 0; }
            blockquote { margin: 8pt 0; padding-left: 12pt; border-left: 4pt solid #ddd; color: #666; }
            table { border-collapse: collapse; width: 100%; margin: 12pt 0; }
            th, td { border: 1pt solid #ddd; padding: 6pt; text-align: left; }
            th { background-color: #f5f5f5; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="markdown-content">${markdownContent}</div>
          <script>
            window.onload = () => {
              setTimeout(() => {
                window.print();
                setTimeout(() => window.close(), 500);
              }, 300);
            };
          </script>
        </body>
        </html>
      `;

        printWindow.document.open();
        printWindow.document.write(htmlContent);
        printWindow.document.close();

        toast.success('PDF export initiated. Check your print dialog.');
      } catch (error) {
        toast.error(`Failed to export PDF: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [filePath, isMarkdownFile, fileName, isDownloadRestricted, openUpgradeModal],
  );

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
      <div className="flex flex-col h-full">
        {/* Header with navigation */}
        <div className="px-4 py-2 flex items-center justify-between border-b flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={goBackToBrowser}
              className="h-8 w-8 flex-shrink-0"
              title="Back to file browser"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            
            <span className="text-sm font-medium truncate">{presentationName}</span>
          </div>
          
          <div className="flex items-center gap-2 flex-shrink-0">
            {hasMultipleFiles && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={navigatePrevious}
                  disabled={!canNavigatePrev}
                  className="h-8 w-8 p-0"
                  title="Previous file (←)"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="text-xs text-muted-foreground px-2">
                  {currentFileIndex + 1} / {filePathList?.length || 0}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={navigateNext}
                  disabled={!canNavigateNext}
                  className="h-8 w-8 p-0"
                  title="Next file (→)"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </>
            )}
            
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenPresentationFullscreen}
              className="h-8 w-8 p-0"
              title="Open fullscreen"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Presentation content - use a mock tool call for PresentationViewer */}
        <div className="flex-1 overflow-hidden">
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
    <div className="flex flex-col h-full">
      {/* Header with breadcrumb navigation and actions */}
      <div className="px-4 py-2 flex items-center justify-between border-b flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={goBackToBrowser}
            className="h-8 w-8 flex-shrink-0"
            title="Back to file browser"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          
          <div className="flex items-center overflow-x-auto min-w-0 scrollbar-hide whitespace-nowrap">
            <span className="text-sm font-medium truncate">{fileName}</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Navigation arrows for file list mode */}
          {hasMultipleFiles && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={navigatePrevious}
                disabled={!canNavigatePrev}
                className="h-8 w-8 p-0"
                title="Previous file (←)"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="text-xs text-muted-foreground px-2">
                {currentFileIndex + 1} / {filePathList?.length || 0}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={navigateNext}
                disabled={!canNavigateNext}
                className="h-8 w-8 p-0"
                title="Next file (→)"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </>
          )}

          {/* Copy content button - only show for text files */}
          {textContentForRenderer && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyContent}
              disabled={isCopyingContent || isCachedFileLoading}
              className="h-8 gap-1"
            >
              {isCopyingContent ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">Copy</span>
            </Button>
          )}

          {/* Download button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={isDownloading || isCachedFileLoading}
            className="h-8 gap-1"
          >
            {isDownloading ? (
              <Loader className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Download</span>
          </Button>

          {/* PDF Export for markdown */}
          {isMarkdownFile && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isCachedFileLoading || contentError !== null}
                  className="h-8 gap-1"
                >
                    <FileText className="h-4 w-4" />
                  <span className="hidden sm:inline">PDF</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleExportPdf('portrait')} className="cursor-pointer">
                  Portrait
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExportPdf('landscape')} className="cursor-pointer">
                  Landscape
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Open in new tab for HTML files */}
          {isHtmlFile && project?.sandbox?.sandbox_url && (
            <Button
              variant="outline"
              size="sm"
              asChild
              className="h-8 gap-1"
            >
              <a
                href={`${project.sandbox.sandbox_url}${filePath.replace('/workspace', '')}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">Open</span>
              </a>
            </Button>
          )}
        </div>
      </div>

      {/* File content */}
      <div className="flex-1 overflow-hidden">
        {isCachedFileLoading ? (
          <div className="h-full w-full flex flex-col items-center justify-center">
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
          <div className="h-full w-full overflow-hidden" style={{ contain: 'strict' }}>
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

              return (
                <EditableFileRenderer
                  key={filePath}
                  content={isBinaryFile ? null : textContentForRenderer}
                  binaryUrl={blobUrlForRenderer}
                  fileName={fileName}
                  filePath={filePath}
                  className="h-full w-full"
                  project={project}
                  readOnly={false}
                  onSave={canEdit ? handleSaveFile : undefined}
                  onDownload={handleDownload}
                  isDownloading={isDownloading}
                />
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
