import React, { useState, useCallback } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Loader2,
  Code,
  Eye,
  File,
  Copy,
  Check,
  Maximize2,
  Presentation,
  Pencil,
  Download,
  FileType,
  FileText,
  FileCode,
} from 'lucide-react';
import {
  formatTimestamp,
  getToolTitle,
} from '../utils';
import {
  CodeEditor,
  processUnicodeContent,
  getFileTypeFromExtension,
} from '@/components/file-editors';
import { UnifiedMarkdown } from '@/components/markdown';
import { CsvRenderer, XlsxRenderer } from '@/components/file-renderers';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { exportDocument, type ExportFormat } from '@/lib/utils/document-export';
import { marked } from 'marked';

import {
  getLanguageFromFileName,
  getOperationType,
  getOperationConfigs,
  getFileIcon,
  processFilePath,
  getFileName,
  getFileExtension,
  isFileType,
  hasLanguageHighlighting,
  splitContentIntoLines,
  generateEmptyLines,
  type FileOperation,
  type OperationConfig,
} from './_utils';
import { ToolViewProps } from '../types';
import { LoadingState } from '../shared/LoadingState';
import { toast } from 'sonner';
import { PresentationSlidePreview } from '../presentation-tools/PresentationSlidePreview';
import { usePresentationViewerStore } from '@/stores/presentation-viewer-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

// Helper functions for presentation slide detection
// Helper function to check if a filepath is a presentation slide file
function isPresentationSlideFile(filepath: string): boolean {
  // Match patterns like:
  // - presentations/[name]/slide_01.html
  // - /workspace/presentations/[name]/slide_01.html
  // - ./presentations/[name]/slide_01.html
  const presentationPattern = /presentations\/([^\/]+)\/slide_\d+\.html$/i;
  return presentationPattern.test(filepath);
}

// Helper function to extract presentation name from filepath
function extractPresentationName(filepath: string): string | null {
  // Match presentations/[name]/ anywhere in the path
  const match = filepath.match(/presentations\/([^\/]+)\//i);
  return match ? match[1] : null;
}

// Helper function to extract slide number from filepath
function extractSlideNumber(filepath: string): number | null {
  const match = filepath.match(/slide_(\d+)\.html$/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

export function FileOperationToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  onFileClick,
  messages,
  streamingText,
}: ToolViewProps) {
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';

  // Presentation viewer store for opening fullscreen presentation
  const { openPresentation } = usePresentationViewerStore();
  
  // Kortix Computer store for opening files in Files Manager
  const { openFileInComputer } = useKortixComputerStore();

  // Extract from structured metadata
  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const args = toolCall.arguments || {};
  const output = toolResult?.output;

  // Add copy functionality state
  const [isCopyingContent, setIsCopyingContent] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const operation = getOperationType(name, args);
  const configs = getOperationConfigs();
  const config = configs[operation];
  const Icon = config.icon;

  let filePath: string | null = null;
  let fileContent: string | null = null;

  // Extract file path from arguments (from metadata)
  filePath = args.file_path || args.target_file || args.path || null;
  
  // Also try to get file path from output first (more reliable for completed operations)
  if (output && typeof output === 'object' && output !== null) {
    if (!filePath && (output.file_path || output.path)) {
      filePath = output.file_path || output.path;
    }
  }

  // STREAMING: Extract content from live streaming JSON arguments
  if (isStreaming && streamingText) {
    try {
      // Try parsing as complete JSON first
      const parsed = JSON.parse(streamingText);

      // Extract based on operation type
      if (operation === 'create' || operation === 'rewrite') {
        if (parsed.file_contents) {
          fileContent = parsed.file_contents;
        }
      } else if (operation === 'edit') {
        if (parsed.code_edit) {
          fileContent = parsed.code_edit;
        }
      }

      // Extract file_path if not already set
      if (!filePath && parsed.file_path) {
        filePath = parsed.file_path;
      }
    } catch (e) {
      // JSON incomplete - extract partial content
      if (operation === 'create' || operation === 'rewrite') {
        // Find the start of file_contents value
        const startMatch = streamingText.match(/"file_contents"\s*:\s*"/);
        if (startMatch) {
          const startIndex = startMatch.index! + startMatch[0].length;
          // Extract everything after "file_contents": " until we hit the end or a closing quote
          let rawContent = streamingText.substring(startIndex);

          // Try to find the end quote (but it might not exist yet during streaming)
          const endQuoteMatch = rawContent.match(/(?<!\\)"/);
          if (endQuoteMatch) {
            rawContent = rawContent.substring(0, endQuoteMatch.index);
          }

          // Unescape JSON sequences like \n, \t, \\, \"
          try {
            fileContent = JSON.parse('"' + rawContent + '"');
          } catch {
            // If unescaping fails, replace common escapes manually
            fileContent = rawContent
              .replace(/\\n/g, '\n')
              .replace(/\\t/g, '\t')
              .replace(/\\r/g, '\r')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\');
          }
        }
      } else if (operation === 'edit') {
        const startMatch = streamingText.match(/"code_edit"\s*:\s*"/);
        if (startMatch) {
          const startIndex = startMatch.index! + startMatch[0].length;
          let rawContent = streamingText.substring(startIndex);

          const endQuoteMatch = rawContent.match(/(?<!\\)"/);
          if (endQuoteMatch) {
            rawContent = rawContent.substring(0, endQuoteMatch.index);
          }

          try {
            fileContent = JSON.parse('"' + rawContent + '"');
          } catch {
            fileContent = rawContent
              .replace(/\\n/g, '\n')
              .replace(/\\t/g, '\t')
              .replace(/\\r/g, '\r')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\');
          }
        }
      }

      // Extract file_path from partial JSON
      if (!filePath) {
        const pathMatch = streamingText.match(/"file_path"\s*:\s*"([^"]+)"/);
        if (pathMatch) {
          filePath = pathMatch[1];
        }
      }
    }
  }  // Fallback: Extract content from args (for completed operations)
  if (!fileContent) {
    fileContent = args.file_contents || args.code_edit || args.updated_content || null;
  }

  // Override with output if available
  if (output) {
    if (typeof output === 'object' && output !== null) {
      fileContent = output.file_content || output.content || output.updated_content || fileContent;
      if (!filePath && output.file_path) {
        filePath = output.file_path;
      }
    } else if (typeof output === 'string' && operation !== 'delete' && operation !== 'create') {
      fileContent = output;
    }
  }

  const toolTitle = getToolTitle(name || `file-${operation}`);
  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);

  const isHtml = isFileType.html(fileExtension);

  // Check if this is a presentation slide file
  const isPresentationSlide = processedFilePath ? isPresentationSlideFile(processedFilePath) : false;
  const presentationName = isPresentationSlide && processedFilePath ? extractPresentationName(processedFilePath) : null;
  const slideNumber = isPresentationSlide && processedFilePath ? extractSlideNumber(processedFilePath) : null;

  // Log for debugging file operations (only when it's a presentation slide)
  if (isPresentationSlide) {
    console.log('[FileOperationToolView] Presentation slide detected:', {
      operation,
      processedFilePath,
      presentationName,
      slideNumber,
      isStreaming,
      hasSandboxUrl: !!project?.sandbox?.sandbox_url,
    });
  }

  const language = getLanguageFromFileName(fileName);
  const hasHighlighting = hasLanguageHighlighting(language);
  const contentLines = React.useMemo(() => splitContentIntoLines(fileContent), [fileContent]);

  const htmlPreviewUrl =
    isHtml && project?.sandbox?.sandbox_url && processedFilePath
      ? constructHtmlPreviewUrl(project.sandbox.sandbox_url, processedFilePath)
      : undefined;

  const FileIcon = getFileIcon(fileName);

  // Auto-scroll refs for streaming
  const sourceScrollRef = React.useRef<HTMLDivElement>(null);
  const previewScrollRef = React.useRef<HTMLDivElement>(null);
  const lastLineCountRef = React.useRef<number>(0);

  // Auto-scroll for source code view during streaming - simple and stable
  React.useEffect(() => {
    if (!isStreaming || !fileContent || !sourceScrollRef.current) return;
    
    // Only scroll when new lines are added
    const currentLineCount = contentLines.length;
    if (currentLineCount <= lastLineCountRef.current) return;
    lastLineCountRef.current = currentLineCount;

    const viewport = sourceScrollRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    if (!viewport) return;

    // Instantly scroll to bottom without smooth behavior to prevent jitter
    viewport.scrollTop = viewport.scrollHeight;
  }, [isStreaming, contentLines.length, fileContent]);

  // Reset line count ref when streaming stops
  React.useEffect(() => {
    if (!isStreaming) {
      lastLineCountRef.current = 0;
    }
  }, [isStreaming]);

  // Auto-scroll for preview tab during streaming - simple approach
  React.useEffect(() => {
    if (!isStreaming || !fileContent || !previewScrollRef.current) return;

    const viewport = previewScrollRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    if (!viewport) return;

    // Instantly scroll to bottom
    viewport.scrollTop = viewport.scrollHeight;
  }, [isStreaming, fileContent]);

  // Copy functions
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  };

  const handleCopyContent = async () => {
    if (!fileContent) return;

    setIsCopyingContent(true);
    const success = await copyToClipboard(fileContent);
    if (success) {
      toast.success('File content copied to clipboard');
    } else {
      toast.error('Failed to copy file content');
    }
    setTimeout(() => setIsCopyingContent(false), 500);
  };

  // Handle file download
  const handleDownload = useCallback(() => {
    if (!fileContent || !processedFilePath || isDownloading) return;

    try {
      setIsDownloading(true);
      
      // Create blob from content
      const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      
      // Create download link
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      // Cleanup
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      
      toast.success('Download started');
    } catch (error) {
      toast.error(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsDownloading(false);
    }
  }, [fileContent, processedFilePath, isDownloading, fileName]);

  // Handle markdown export (PDF, DOCX, HTML, Markdown)
  const handleExport = useCallback(async (format: ExportFormat) => {
    if (!fileContent || !fileName) return;

    setIsExporting(true);
    try {
      // Convert markdown to HTML
      const htmlContent = marked.parse(fileContent, { async: false }) as string;
      
      await exportDocument({
        content: htmlContent,
        fileName: fileName.replace(/\.(md|markdown)$/i, ''),
        format,
      });
    } catch (error) {
      console.error('Export error:', error);
      toast.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExporting(false);
    }
  }, [fileContent, fileName]);

  // Always show FileOperationToolView for file operations, even during streaming
  // Don't fallback to GenericToolView

  const renderFilePreview = () => {
    // Handle presentation slide files specially
    if (isPresentationSlide && presentationName) {
      // During streaming, show a nice preview with the HTML content being written
      if (isStreaming) {
        return (
          <div className="w-full h-full flex flex-col items-center justify-center p-8 bg-white dark:bg-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60">
              <Presentation className="h-10 w-10 text-blue-500 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              Updating Presentation
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center mb-4">
              {presentationName}{slideNumber ? ` - Slide ${slideNumber}` : ''}
            </p>
            <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Writing slide content...</span>
            </div>
          </div>
        );
      }

      // After streaming completes, show the presentation preview if sandbox URL is available
      if (project?.sandbox?.sandbox_url) {
        return (
          <div className="w-full h-full flex flex-col bg-white dark:bg-zinc-900">
            <div className="flex-1 p-4">
              <PresentationSlidePreview
                key={`${presentationName}-${slideNumber}`}
                presentationName={presentationName}
                project={project}
                initialSlide={slideNumber || undefined}
                onFullScreenClick={(slideNum) => {
                  console.log('[FileOperationToolView] Opening presentation fullscreen:', {
                    presentationName,
                    sandboxUrl: project.sandbox.sandbox_url,
                    slideNumber: slideNum || slideNumber || 1
                  });
                  openPresentation(
                    presentationName,
                    project.sandbox.sandbox_url,
                    slideNum || slideNumber || 1
                  );
                }}
                className="w-full"
              />
            </div>
            <div className="px-4 pb-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  openPresentation(
                    presentationName,
                    project.sandbox.sandbox_url,
                    slideNumber || 1
                  );
                }}
                className="w-full gap-2"
              >
                <Presentation className="h-4 w-4" />
                Open Presentation Viewer
              </Button>
            </div>
          </div>
        );
      }
      
      // Sandbox URL not available yet - show waiting state
      return (
        <div className="w-full h-full flex flex-col items-center justify-center p-8 bg-white dark:bg-zinc-900">
          <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60">
            <Presentation className="h-10 w-10 text-blue-500 dark:text-blue-400" />
          </div>
          <h3 className="text-lg font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
            Presentation Updated
          </h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center">
            {presentationName}{slideNumber ? ` - Slide ${slideNumber}` : ''}
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">
            Waiting for sandbox to be ready...
          </p>
        </div>
      );
    }

    if (!fileContent) {
      return (
        <div className="flex items-center justify-center h-full p-12 bg-white dark:bg-zinc-900">
          <div className="text-center">
            <FileIcon className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No content to preview</p>
          </div>
        </div>
      );
    }

    // Determine file type for rendering
    const fileType = getFileTypeFromExtension(fileName);
    const isMarkdown = fileExtension === 'md' || fileExtension === 'markdown';
    const isCsv = fileExtension === 'csv' || fileExtension === 'tsv';
    const isXlsx = fileExtension === 'xlsx' || fileExtension === 'xls';
    
    // For HTML files with preview URL, use iframe directly
    if (isHtml && htmlPreviewUrl) {
      return (
        <div className="w-full max-w-full h-full overflow-hidden min-w-0">
          <iframe
            src={htmlPreviewUrl}
            title={`HTML Preview of ${fileName}`}
            className="w-full h-full border-0 max-w-full"
            sandbox="allow-same-origin allow-scripts"
          />
        </div>
      );
    }

    // For markdown files
    if (isMarkdown) {
      return (
        <div className="h-full overflow-auto p-4 bg-white dark:bg-zinc-900">
          <UnifiedMarkdown content={processUnicodeContent(fileContent)} />
        </div>
      );
    }

    // For CSV files
    if (isCsv) {
      return (
        <div className="p-6 flex flex-col">
          <div className="flex-1 min-h-[400px] w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
            <CsvRenderer content={processUnicodeContent(fileContent)} />
          </div>
        </div>
      );
    }

    // For XLSX files
    if (isXlsx) {
      return (
        <div className="p-6 flex flex-col">
          <div className="flex-1 min-h-[400px] w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
            <XlsxRenderer
              content={fileContent}
              filePath={processedFilePath}
              fileName={fileName}
              project={project}
            />
          </div>
        </div>
      );
    }

    // For all other files, use CodeEditor in read-only mode
    return (
      <div className="w-full max-w-full bg-white dark:bg-zinc-900 min-w-0">
        <CodeEditor
          content={processUnicodeContent(fileContent)}
          fileName={fileName}
          readOnly={true}
          className="w-full max-w-full"
        />
      </div>
    );
  };

  const renderDeleteOperation = () => (
    <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-white dark:bg-zinc-900">
      <div className={cn("w-20 h-20 rounded-full flex items-center justify-center mb-6", config.bgColor)}>
        <Icon className={cn("h-10 w-10", config.color)} />
      </div>
      <h3 className="text-xl font-semibold mb-6 text-zinc-900 dark:text-zinc-100">
        File Deleted
      </h3>
      <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 w-full max-w-md text-center mb-4 shadow-sm">
        <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
          {processedFilePath || 'Unknown file path'}
        </code>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        This file has been permanently removed
      </p>
    </div>
  );

  const renderSourceCode = () => {
    if (!fileContent) {
      return (
        <div className="flex items-center justify-center h-full p-12 bg-white dark:bg-zinc-900">
          <div className="text-center">
            <FileIcon className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No source code to display</p>
          </div>
        </div>
      );
    }

    // Always use file-lines rendering for consistency
    // Add empty lines to fill viewport
    const emptyLines = generateEmptyLines(50); // Add 50 empty lines for natural scrolling
    const allLines = [...contentLines, ...emptyLines];

    return (
      <div className="w-full max-w-full table bg-white dark:bg-zinc-900 overflow-x-auto">
        {allLines.map((line, idx) => (
          <div
            key={idx}
            className={cn("table-row transition-colors", config.hoverColor)}
          >
            <div className="table-cell text-right pr-4 pl-4 py-0.5 text-xs text-zinc-400 dark:text-zinc-600 select-none w-14 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 flex-shrink-0">
              {idx + 1}
            </div>
            <div className="table-cell pl-4 py-0.5 pr-4 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900 max-w-full min-w-0">
              {line ? processUnicodeContent(line, true) : ' '}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Determine icon and colors based on whether it's a presentation slide
  const HeaderIcon = isPresentationSlide ? Presentation : Icon;
  const headerIconColor = isPresentationSlide ? 'text-blue-500 dark:text-blue-400' : config.color;
  const headerGradientBg = isPresentationSlide ? 'from-blue-50 to-blue-100 dark:from-blue-800/40 dark:to-blue-900/60' : config.gradientBg;
  const headerBorderColor = isPresentationSlide ? 'border-blue-200 dark:border-blue-700' : config.borderColor;
  const displayTitle = isPresentationSlide && presentationName 
    ? `${toolTitle} - ${presentationName}${slideNumber ? ` (Slide ${slideNumber})` : ''}`
    : toolTitle;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card max-w-full min-w-0">
      <Tabs defaultValue="preview" className="w-full h-full max-w-full min-w-0">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2 mb-0 max-w-full min-w-0">
          <div className="flex flex-row items-center justify-between gap-3 max-w-full min-w-0">
            <div className="flex items-center gap-3 min-w-0 flex-1 max-w-full">
              <div className={cn("relative p-2 rounded-lg border flex-shrink-0", `bg-gradient-to-br ${headerGradientBg}`, headerBorderColor)}>
                <HeaderIcon className={cn("h-5 w-5", headerIconColor)} />
              </div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {displayTitle}
              </CardTitle>
              <TabsList className="h-8 bg-muted/50 border border-border/50 p-0.5 gap-0.5 flex-shrink-0">
                <TabsTrigger
                  value="code"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all [&[data-state=active]]:bg-white [&[data-state=active]]:dark:bg-primary/10 [&[data-state=active]]:text-foreground hover:bg-background/50 text-muted-foreground shadow-none"
                >
                  <Code className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Source</span>
                </TabsTrigger>
                <TabsTrigger
                  value="preview"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all [&[data-state=active]]:bg-white [&[data-state=active]]:dark:bg-primary/10 [&[data-state=active]]:text-foreground hover:bg-background/50 text-muted-foreground shadow-none"
                >
                  <Eye className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Preview</span>
                </TabsTrigger>
              </TabsList>
            </div>
            <div className='flex items-center gap-1.5 flex-shrink-0'>
              {fileContent && !isStreaming && !isPresentationSlide && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyContent}
                  disabled={isCopyingContent}
                  className="h-8 w-8 p-0"
                  title="Copy file content"
                >
                  {isCopyingContent ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              )}
              {/* Download button */}
              {fileContent && !isStreaming && !isPresentationSlide && operation !== 'delete' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDownload}
                  disabled={isDownloading}
                  className="h-8 w-8 p-0"
                  title="Download file"
                >
                  {isDownloading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                </Button>
              )}
              {/* Edit in Files Manager button */}
              {processedFilePath && !isStreaming && !isPresentationSlide && operation !== 'delete' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openFileInComputer(processedFilePath)}
                  className="h-8 gap-1.5 px-2"
                  title="Edit in Files Manager"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="text-xs hidden sm:inline">Edit</span>
                </Button>
              )}
              {/* Presentation fullscreen button */}
              {isPresentationSlide && presentationName && project?.sandbox?.sandbox_url && !isStreaming && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    openPresentation(
                      presentationName,
                      project.sandbox.sandbox_url,
                      slideNumber || 1
                    );
                  }}
                  className="h-8 w-8 p-0"
                  title="Open presentation fullscreen"
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0 -my-2 h-full flex-1 overflow-hidden relative bg-white dark:bg-zinc-900 flex flex-col min-h-0 max-w-full min-w-0">
          <TabsContent value="code" className="flex-1 h-full mt-0 p-0 overflow-hidden bg-white dark:bg-zinc-900 flex flex-col min-h-0 max-w-full min-w-0">
            <ScrollArea ref={sourceScrollRef} className="h-full w-full flex-1 min-h-0 max-w-full">
              {!fileContent && !isStreaming ? (
                <LoadingState
                  icon={Icon}
                  iconColor={config.color}
                  bgColor={config.bgColor}
                  title={config.progressMessage}
                  filePath={processedFilePath || 'Processing file...'}
                  subtitle="Please wait while the file is being processed"
                  showProgress={false}
                />
              ) : !fileContent && isStreaming ? (
                <div className="flex items-center justify-center h-full p-12 bg-white dark:bg-zinc-900">
                  <div className="text-center">
                    <Loader2 className="h-8 w-8 mx-auto mb-4 text-zinc-400 animate-spin" />
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">Waiting for content...</p>
                  </div>
                </div>
              ) : operation === 'delete' ? (
                <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-white dark:bg-zinc-900">
                  <div className={cn("w-20 h-20 rounded-full flex items-center justify-center mb-6", config.bgColor)}>
                    <Icon className={cn("h-10 w-10", config.color)} />
                  </div>
                  <h3 className="text-xl font-semibold mb-6 text-zinc-900 dark:text-zinc-100">
                    Delete Operation
                  </h3>
                  <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 w-full max-w-md text-center">
                    <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
                      {processedFilePath || 'Unknown file path'}
                    </code>
                  </div>
                </div>
              ) : (
                renderSourceCode()
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="preview" className="w-full max-w-full flex-1 h-full mt-0 p-0 overflow-hidden bg-white dark:bg-zinc-900 flex flex-col min-h-0 min-w-0">
            {/* Presentation slides have their own loading/streaming state */}
            {isPresentationSlide && presentationName ? (
              <div className="w-full max-w-full h-full relative bg-white dark:bg-zinc-900 flex-1 min-h-0 min-w-0 overflow-hidden">
                {renderFilePreview()}
              </div>
            ) : isHtml && htmlPreviewUrl ? (
              // For HTML files, render iframe directly without ScrollArea for full viewport
              <div className="w-full max-w-full h-full relative bg-white dark:bg-zinc-900 flex-1 min-h-0 min-w-0 overflow-hidden">
                {renderFilePreview()}
              </div>
            ) : (
              // For non-HTML files, use ScrollArea with smooth auto-scroll
              <ScrollArea ref={previewScrollRef} className="h-full w-full max-w-full flex-1 min-h-0 bg-white dark:bg-zinc-900 min-w-0">
                {!fileContent && !isStreaming ? (
                  <LoadingState
                    icon={Icon}
                    iconColor={config.color}
                    bgColor={config.bgColor}
                    title={config.progressMessage}
                    filePath={processedFilePath || 'Processing file...'}
                    subtitle="Please wait while the file is being processed"
                    showProgress={false}
                  />
                ) : !fileContent && isStreaming ? (
                  <div className="flex items-center justify-center h-full p-12 bg-white dark:bg-zinc-900">
                    <div className="text-center">
                      <Loader2 className="h-8 w-8 mx-auto mb-4 text-zinc-400 animate-spin" />
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">Waiting for content...</p>
                    </div>
                  </div>
                ) : operation === 'delete' ? (
                  renderDeleteOperation()
                ) : (
                  renderFilePreview()
                )}
              </ScrollArea>
            )}
          </TabsContent>
        </CardContent>

        <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
          <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Badge variant="outline" className="py-0.5 h-6">
              <FileIcon className="h-3 w-3" />
              {hasHighlighting ? language.toUpperCase() : fileExtension.toUpperCase() || 'TEXT'}
            </Badge>
          </div>

          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {toolTimestamp && !isStreaming
              ? formatTimestamp(toolTimestamp)
              : assistantTimestamp
                ? formatTimestamp(assistantTimestamp)
                : ''}
          </div>
        </div>
      </Tabs>
    </Card>
  );
}