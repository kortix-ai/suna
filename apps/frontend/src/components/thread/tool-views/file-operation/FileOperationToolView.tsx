import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  ExternalLink,
  Loader2,
  Code,
  Eye,
  File,
  Copy,
  Check,
  Presentation,
  Pencil,
  FileDiff,
  Minus,
  Plus,
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
import { HtmlRenderer, JsonRenderer } from '@/components/file-renderers';
import dynamic from 'next/dynamic';
import { cn } from '@/lib/utils';

// Lazy load SpreadsheetViewer as it imports Syncfusion (~1-2 MB)
const SpreadsheetViewer = dynamic(
  () => import('../spreadsheet/SpreadsheetViewer').then((mod) => mod.SpreadsheetViewer),
  { ssr: false, loading: () => <div className="p-4 text-muted-foreground">Loading spreadsheet...</div> }
);
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
import { FileDownloadButton } from '../shared/FileDownloadButton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

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
  generateLineDiff,
  calculateDiffStats,
  type FileOperation,
  type OperationConfig,
  type LineDiff,
  type DiffStats,
} from './_utils';
import { ToolViewProps } from '../types';
import { LoadingState } from '../shared/LoadingState';
import { toast } from 'sonner';
import { PresentationSlidePreview } from '../presentation-tools/PresentationSlidePreview';
import { usePresentationViewerStore } from '@/stores/presentation-viewer-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

const UnifiedDiffView: React.FC<{ lineDiff: LineDiff[]; fileName?: string }> = ({ lineDiff, fileName }) => (
  <div className="font-mono text-[13px] leading-relaxed">
    {lineDiff.map((line, i) => (
      <div
        key={i}
        className={cn(
          "flex border-l-2 transition-colors",
          line.type === 'removed' && "bg-red-50/80 dark:bg-red-950/40 border-l-red-400 dark:border-l-red-500",
          line.type === 'added' && "bg-emerald-50/80 dark:bg-emerald-950/40 border-l-emerald-400 dark:border-l-emerald-500",
          line.type === 'unchanged' && "bg-transparent border-l-transparent hover:bg-zinc-50 dark:hover:bg-zinc-900/50",
        )}
      >
        <div className="w-12 text-right select-none py-1 pr-3 text-[11px] text-zinc-400 dark:text-zinc-500 flex-shrink-0 tabular-nums">
          {line.lineNumber}
        </div>
        <div className={cn(
          "w-6 flex items-center justify-center flex-shrink-0",
          line.type === 'removed' && "text-red-500 dark:text-red-400",
          line.type === 'added' && "text-emerald-500 dark:text-emerald-400",
        )}>
          {line.type === 'removed' && <span className="font-bold">−</span>}
          {line.type === 'added' && <span className="font-bold">+</span>}
        </div>
        <div className="flex-1 py-1 pr-4 min-w-0">
          <code className={cn(
            "whitespace-pre-wrap break-words",
            line.type === 'removed' && "text-red-800 dark:text-red-300",
            line.type === 'added' && "text-emerald-800 dark:text-emerald-300",
            line.type === 'unchanged' && "text-zinc-600 dark:text-zinc-400",
          )}>
            {line.type === 'removed' ? line.oldLine : line.type === 'added' ? line.newLine : line.oldLine}
          </code>
        </div>
      </div>
    ))}
  </div>
);

const SplitDiffView: React.FC<{ lineDiff: LineDiff[] }> = ({ lineDiff }) => (
  <div className="font-mono text-[13px] leading-relaxed grid grid-cols-2 divide-x divide-zinc-200 dark:divide-zinc-800">
    {/* Left side - Removed */}
    <div>
      <div className="px-3 py-2 bg-red-50/50 dark:bg-red-950/20 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-[11px] font-medium text-red-600 dark:text-red-400 uppercase tracking-wide flex items-center gap-1.5">
          <Minus className="h-3 w-3" />
          Before
        </span>
      </div>
      {lineDiff.map((line, i) => (
        <div
          key={i}
          className={cn(
            "flex border-l-2 transition-colors",
            line.type === 'removed' && "bg-red-50/80 dark:bg-red-950/40 border-l-red-400",
            line.type !== 'removed' && "border-l-transparent",
            line.oldLine === null && "opacity-40"
          )}
        >
          <div className="w-10 text-right select-none py-1 pr-2 text-[11px] text-zinc-400 dark:text-zinc-500 flex-shrink-0 tabular-nums">
            {line.oldLine !== null ? line.lineNumber : ''}
          </div>
          <div className="flex-1 py-1 px-2 min-w-0">
            <code className={cn(
              "whitespace-pre-wrap break-words text-xs",
              line.type === 'removed' ? "text-red-800 dark:text-red-300" : "text-zinc-500 dark:text-zinc-500",
            )}>
              {line.oldLine || ''}
            </code>
          </div>
        </div>
      ))}
    </div>
    {/* Right side - Added */}
    <div>
      <div className="px-3 py-2 bg-emerald-50/50 dark:bg-emerald-950/20 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wide flex items-center gap-1.5">
          <Plus className="h-3 w-3" />
          After
        </span>
      </div>
      {lineDiff.map((line, i) => (
        <div
          key={i}
          className={cn(
            "flex border-l-2 transition-colors",
            line.type === 'added' && "bg-emerald-50/80 dark:bg-emerald-950/40 border-l-emerald-400",
            line.type !== 'added' && "border-l-transparent",
            line.newLine === null && "opacity-40"
          )}
        >
          <div className="w-10 text-right select-none py-1 pr-2 text-[11px] text-zinc-400 dark:text-zinc-500 flex-shrink-0 tabular-nums">
            {line.newLine !== null ? line.lineNumber : ''}
          </div>
          <div className="flex-1 py-1 px-2 min-w-0">
            <code className={cn(
              "whitespace-pre-wrap break-words text-xs",
              line.type === 'added' ? "text-emerald-800 dark:text-emerald-300" : "text-zinc-500 dark:text-zinc-500",
            )}>
              {line.newLine || ''}
            </code>
          </div>
        </div>
      ))}
    </div>
  </div>
);

function isPresentationSlideFile(filepath: string): boolean {
  const presentationPattern = /presentations\/([^\/]+)\/slide_\d+\.html$/i;
  return presentationPattern.test(filepath);
}

function extractPresentationName(filepath: string): string | null {
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
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified');

  const operation = getOperationType(name, args);
  const isStrReplace = operation === 'str-replace';
  const configs = getOperationConfigs();
  const config = configs[operation];
  const Icon = config.icon;

  const rawStreamingSource = toolCall.rawArguments || streamingText;
  
  const [throttledStreamingSource, setThrottledStreamingSource] = useState(rawStreamingSource);
  const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastUpdateRef = useRef<number>(0);
  
  useEffect(() => {
    if (!isStreaming) {
      setThrottledStreamingSource(rawStreamingSource);
      return;
    }
    
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateRef.current;
    
    if (timeSinceLastUpdate >= 100) {
      setThrottledStreamingSource(rawStreamingSource);
      lastUpdateRef.current = now;
    } else {
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
      }
      throttleTimeoutRef.current = setTimeout(() => {
        setThrottledStreamingSource(rawStreamingSource);
        lastUpdateRef.current = Date.now();
      }, 100 - timeSinceLastUpdate);
    }
    
    return () => {
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
      }
    };
  }, [rawStreamingSource, isStreaming]);
  
  const streamingSource = isStreaming ? throttledStreamingSource : rawStreamingSource;

  const extractedContent = useMemo(() => {
    let filePath: string | null = args.file_path || args.target_file || args.path || null;
    let fileContent: string | null = null;
    let oldStr: string | null = null;
    let newStr: string | null = null;

    if (isStrReplace) {
      oldStr = args.old_str || args.old_string || null;
      newStr = args.new_str || args.new_string || null;
    }

    if (output && typeof output === 'object' && output !== null) {
      if (!filePath && (output.file_path || output.path)) {
        filePath = output.file_path || output.path;
      }
    }

    if (isStreaming && streamingSource) {
      try {
        const parsed = JSON.parse(streamingSource);

        if (operation === 'create' || operation === 'rewrite') {
          if (parsed.file_contents) {
            fileContent = parsed.file_contents;
          }
        } else if (operation === 'edit') {
          if (parsed.code_edit) {
            fileContent = parsed.code_edit;
          }
        } else if (isStrReplace) {
          if (parsed.old_str || parsed.old_string) {
            oldStr = parsed.old_str || parsed.old_string;
          }
          if (parsed.new_str || parsed.new_string) {
            newStr = parsed.new_str || parsed.new_string;
          }
        }

        if (!filePath && parsed.file_path) {
          filePath = parsed.file_path;
        }
      } catch (e) {
        if (operation === 'create' || operation === 'rewrite') {
          const startMatch = streamingSource.match(/"file_contents"\s*:\s*"/);
          if (startMatch) {
            const startIndex = startMatch.index! + startMatch[0].length;
            let rawContent = streamingSource.substring(startIndex);
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
        } else if (operation === 'edit') {
          const startMatch = streamingSource.match(/"code_edit"\s*:\s*"/);
          if (startMatch) {
            const startIndex = startMatch.index! + startMatch[0].length;
            let rawContent = streamingSource.substring(startIndex);
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
        } else if (isStrReplace) {
          const oldStrMatch = streamingSource.match(/"(?:old_str|old_string)"\s*:\s*"/);
          if (oldStrMatch) {
            const startIndex = oldStrMatch.index! + oldStrMatch[0].length;
            let rawContent = streamingSource.substring(startIndex);
            const endQuoteMatch = rawContent.match(/(?<!\\)"/);
            if (endQuoteMatch) {
              rawContent = rawContent.substring(0, endQuoteMatch.index);
            }
            try {
              oldStr = JSON.parse('"' + rawContent + '"');
            } catch {
              oldStr = rawContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
          }
          const newStrMatch = streamingSource.match(/"(?:new_str|new_string)"\s*:\s*"/);
          if (newStrMatch) {
            const startIndex = newStrMatch.index! + newStrMatch[0].length;
            let rawContent = streamingSource.substring(startIndex);
            const endQuoteMatch = rawContent.match(/(?<!\\)"/);
            if (endQuoteMatch) {
              rawContent = rawContent.substring(0, endQuoteMatch.index);
            }
            try {
              newStr = JSON.parse('"' + rawContent + '"');
            } catch {
              newStr = rawContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
          }
        }

        if (!filePath) {
          const pathMatch = streamingSource.match(/"file_path"\s*:\s*"([^"]+)"/);
          if (pathMatch) {
            filePath = pathMatch[1];
          }
        }
      }
    }

    if (!fileContent) {
      fileContent = args.file_contents || args.code_edit || args.updated_content || null;
    }

    if (output) {
      if (typeof output === 'object' && output !== null) {
        fileContent = output.file_content || output.content || output.updated_content || fileContent;
        if (!filePath && output.file_path) {
          filePath = output.file_path;
        }
        if (isStrReplace || operation === 'edit') {
          oldStr = oldStr || output.old_str || output.old_string || output.original_content || null;
          newStr = newStr || output.new_str || output.new_string || output.updated_content || null;
          if (output.updated_content) {
            fileContent = output.updated_content;
          }
        }
      } else if (typeof output === 'string') {
        try {
          const parsed = JSON.parse(output);
          if (parsed.updated_content) {
            fileContent = parsed.updated_content;
          }
          if (parsed.file_path && !filePath) {
            filePath = parsed.file_path;
          }
          if (isStrReplace || operation === 'edit') {
            oldStr = oldStr || parsed.old_str || parsed.old_string || parsed.original_content || null;
            newStr = newStr || parsed.new_str || parsed.new_string || parsed.updated_content || null;
          }
        } catch (e) {
          if (operation !== 'delete' && operation !== 'create' && operation !== 'rewrite') {
            fileContent = output;
          }
        }
      }
    }

    return { filePath, fileContent, oldStr, newStr };
  }, [args, output, isStreaming, streamingSource, operation, isStrReplace]);

  const { filePath, fileContent, oldStr, newStr } = extractedContent;

  // Generate diff data for str-replace and edit operations
  const lineDiff = React.useMemo(() => {
    if (oldStr && newStr) {
      return generateLineDiff(oldStr, newStr);
    }
    return [];
  }, [oldStr, newStr]);

  const diffStats: DiffStats = React.useMemo(() => {
    return calculateDiffStats(lineDiff);
  }, [lineDiff]);

  const toolTitle = getToolTitle(name || `file-${operation}`);
  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);

  const isHtml = isFileType.html(fileExtension);
  const isCsv = fileExtension === 'csv' || fileExtension === 'tsv';
  const isXlsx = fileExtension === 'xlsx' || fileExtension === 'xls';

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
  
  // Only calculate content lines for non-streaming or when actually needed
  const contentLines = useMemo(() => splitContentIntoLines(fileContent), [fileContent]);

  const htmlPreviewUrl =
    isHtml && project?.sandbox?.sandbox_url && processedFilePath
      ? constructHtmlPreviewUrl(project.sandbox.sandbox_url, processedFilePath)
      : undefined;

  const FileIcon = getFileIcon(fileName);

  // Auto-scroll refs for streaming
  const sourceScrollRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const lastLineCountRef = useRef<number>(0);
  const isUserScrollingSourceRef = useRef<boolean>(false);
  const isUserScrollingPreviewRef = React.useRef<boolean>(false);

  const isNearBottom = (element: HTMLElement, threshold: number = 100): boolean => {
    return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
  };

  React.useEffect(() => {
    const viewport = sourceScrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    if (!viewport) return;

    const handleScroll = () => {
      // Only allow auto-scroll when user is near the bottom
      // Don't use timeout - respect user's scroll position continuously
      isUserScrollingSourceRef.current = !isNearBottom(viewport);
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', handleScroll);
    };
  }, []);

  React.useEffect(() => {
    const viewport = previewScrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    if (!viewport) return;

    const handleScroll = () => {
      // Only allow auto-scroll when user is near the bottom
      // Don't use timeout - respect user's scroll position continuously
      isUserScrollingPreviewRef.current = !isNearBottom(viewport);
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // Auto-scroll for source code view during streaming - simple and stable
  React.useEffect(() => {
    if (!isStreaming || !fileContent || !sourceScrollRef.current) return;
    
    const currentLineCount = contentLines.length;
    if (currentLineCount <= lastLineCountRef.current) return;
    lastLineCountRef.current = currentLineCount;

    const viewport = sourceScrollRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    if (!viewport) return;

    if (isUserScrollingSourceRef.current) return;

    viewport.scrollTop = viewport.scrollHeight;
  }, [isStreaming, contentLines.length, fileContent]);

  // Reset line count ref when streaming stops
  React.useEffect(() => {
    if (!isStreaming) {
      lastLineCountRef.current = 0;
      isUserScrollingSourceRef.current = false;
      isUserScrollingPreviewRef.current = false;
    }
  }, [isStreaming]);

  // Auto-scroll for preview tab during streaming - simple approach
  React.useEffect(() => {
    if (!isStreaming || !fileContent || !previewScrollRef.current) return;

    const viewport = previewScrollRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    if (!viewport) return;

    if (isUserScrollingPreviewRef.current) return;

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

    const fileType = getFileTypeFromExtension(fileName);
    const isMarkdown = fileExtension === 'md' || fileExtension === 'markdown';
    const isJson = fileExtension === 'json';
    
    // For HTML files, use HtmlRenderer with Preview/Code/Open buttons (but show CodeMirror during streaming)
    if (isHtml && !isStreaming) {
      return (
        <div className="w-full max-w-full h-full overflow-hidden min-w-0">
          <HtmlRenderer
            content={fileContent || ''}
            previewUrl={htmlPreviewUrl || ''}
            className="w-full h-full"
            project={project}
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

    // For JSON files
    if (isJson) {
      return (
        <JsonRenderer content={fileContent} />
      );
    }

    // For CSV and XLSX files
    if (isCsv || isXlsx) {
      return (
        <div className="w-full h-full overflow-hidden">
          <SpreadsheetViewer
            filePath={filePath}
            fileName={fileName}
            sandboxId={project?.sandbox?.id}
            project={project}
            className="w-full h-full"
          />
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

    // PERFORMANCE FIX: Use CodeEditor (which uses virtualized CodeMirror) instead of
    // creating individual DOM elements for each line. This prevents browser hangs
    // when streaming large files.
    return (
      <div className="w-full max-w-full bg-white dark:bg-zinc-900 min-w-0">
        <CodeEditor
          content={processUnicodeContent(fileContent)}
          fileName={fileName}
          readOnly={true}
          className="w-full max-w-full"
          showLineNumbers={true}
        />
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

  const hasDiffData = ((operation === 'edit' || isStrReplace) && oldStr && newStr);


  const defaultTab = (isStrReplace || operation === 'edit') && hasDiffData ? 'changes' : 'preview';
  
  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card max-w-full min-w-0">
      <Tabs defaultValue={defaultTab} className="w-full h-full max-w-full min-w-0">
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
                {hasDiffData && (
                  <TabsTrigger
                    value="changes"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all [&[data-state=active]]:bg-white [&[data-state=active]]:dark:bg-primary/10 [&[data-state=active]]:text-foreground hover:bg-background/50 text-muted-foreground shadow-none"
                  >
                    <FileDiff className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Changes</span>
                  </TabsTrigger>
                )}
                <TabsTrigger
                  value="preview"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all [&[data-state=active]]:bg-white [&[data-state=active]]:dark:bg-primary/10 [&[data-state=active]]:text-foreground hover:bg-background/50 text-muted-foreground shadow-none"
                >
                  <Eye className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Preview</span>
                </TabsTrigger>
                <TabsTrigger
                  value="code"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all [&[data-state=active]]:bg-white [&[data-state=active]]:dark:bg-primary/10 [&[data-state=active]]:text-foreground hover:bg-background/50 text-muted-foreground shadow-none"
                >
                  <Code className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Source</span>
                </TabsTrigger>
              </TabsList>
            </div>
            <TooltipProvider delayDuration={0}>
              <div className='flex items-center gap-1.5 flex-shrink-0'>
                {!isPresentationSlide && operation !== 'delete' && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleCopyContent}
                        disabled={isCopyingContent || isStreaming || !fileContent}
                        className="h-8 w-8 p-0"
                      >
                        {isCopyingContent ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {isStreaming ? 'Available when complete' : 'Copy file content'}
                    </TooltipContent>
                  </Tooltip>
                )}
                {!isPresentationSlide && operation !== 'delete' && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <FileDownloadButton
                          content={fileContent || ''}
                          fileName={fileName}
                          disabled={isStreaming || !fileContent}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {isStreaming ? 'Available when complete' : 'Download file'}
                    </TooltipContent>
                  </Tooltip>
                )}
                {processedFilePath && !isPresentationSlide && operation !== 'delete' && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openFileInComputer(processedFilePath)}
                        disabled={isStreaming}
                        className="h-8 gap-1.5 px-2"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        <span className="text-xs hidden sm:inline">Edit</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {isStreaming ? 'Available when complete' : 'Edit in Files Manager'}
                    </TooltipContent>
                  </Tooltip>
                )}
                {isPresentationSlide && presentationName && project?.sandbox?.sandbox_url && (
                  <Tooltip>
                    <TooltipTrigger asChild>
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
                        disabled={isStreaming}
                        className="h-8 w-8 p-0"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {isStreaming ? 'Available when complete' : 'Open presentation fullscreen'}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </TooltipProvider>
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
            {isPresentationSlide && presentationName ? (
              <div className="w-full max-w-full h-full relative bg-white dark:bg-zinc-900 flex-1 min-h-0 min-w-0 overflow-hidden">
                {renderFilePreview()}
              </div>
            ) : isHtml && htmlPreviewUrl && !isStreaming ? (
              <div className="w-full max-w-full h-full relative bg-white dark:bg-zinc-900 flex-1 min-h-0 min-w-0 overflow-hidden">
                {renderFilePreview()}
              </div>
            ) : (isCsv || isXlsx) ? (
              <div className="w-full max-w-full h-full relative bg-white dark:bg-zinc-900 flex-1 min-h-0 min-w-0 overflow-hidden">
                {renderFilePreview()}
              </div>
            ) : (
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

          {hasDiffData && (
            <TabsContent value="changes" className="flex-1 h-full mt-0 p-0 overflow-hidden bg-white dark:bg-zinc-950 flex flex-col min-h-0 max-w-full min-w-0">
              {isStreaming && (!oldStr || !newStr) ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 mx-auto bg-gradient-to-b from-violet-100 to-violet-50 dark:from-violet-800/40 dark:to-violet-900/60">
                      <FileDiff className="h-8 w-8 text-violet-500 dark:text-violet-400" />
                    </div>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">Processing changes...</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between px-4 py-2 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2 text-xs font-medium">
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <Plus className="h-3.5 w-3.5" />
                          {diffStats.additions} added
                        </span>
                        <span className="text-zinc-300 dark:text-zinc-700">·</span>
                        <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                          <Minus className="h-3.5 w-3.5" />
                          {diffStats.deletions} removed
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-md p-0.5">
                      <button
                        onClick={() => setDiffViewMode('unified')}
                        className={cn(
                          "px-2.5 py-1 text-xs font-medium rounded transition-all",
                          diffViewMode === 'unified' 
                            ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm" 
                            : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                        )}
                      >
                        Unified
                      </button>
                      <button
                        onClick={() => setDiffViewMode('split')}
                        className={cn(
                          "px-2.5 py-1 text-xs font-medium rounded transition-all",
                          diffViewMode === 'split' 
                            ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm" 
                            : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                        )}
                      >
                        Split
                      </button>
                    </div>
                  </div>
                  <ScrollArea className="flex-1 min-h-0">
                    <div className="bg-white dark:bg-zinc-950">
                      {diffViewMode === 'unified' ? (
                        <UnifiedDiffView lineDiff={lineDiff} fileName={fileName} />
                      ) : (
                        <SplitDiffView lineDiff={lineDiff} />
                      )}
                    </div>
                  </ScrollArea>
                  {isStreaming && oldStr && newStr && (
                    <div className="px-4 py-2 bg-violet-50 dark:bg-violet-950/30 border-t border-violet-200 dark:border-violet-800 flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
                      <span className="text-xs text-violet-600 dark:text-violet-400">Streaming changes...</span>
                    </div>
                  )}
                </>
              )}
            </TabsContent>
          )}
        </CardContent>

        <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
          <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Badge variant="outline" className="py-0.5 h-6">
              <FileIcon className="h-3 w-3 mr-1" />
              {hasHighlighting ? language.toUpperCase() : fileExtension.toUpperCase() || 'TEXT'}
            </Badge>
            {hasDiffData && diffStats.additions + diffStats.deletions > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-emerald-600 dark:text-emerald-400">+{diffStats.additions}</span>
                <span className="text-red-600 dark:text-red-400">-{diffStats.deletions}</span>
              </div>
            )}
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