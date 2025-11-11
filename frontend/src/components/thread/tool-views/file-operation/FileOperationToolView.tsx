import React, { useState } from 'react';
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
} from 'lucide-react';
import {
  extractFilePath,
  extractFileContent,
  extractStreamingFileContent,
  formatTimestamp,
  getToolTitle,
  normalizeContentToString,
  extractToolData,
} from '../utils';
import {
  MarkdownRenderer,
  processUnicodeContent,
} from '@/components/file-renderers/authenticated-markdown-renderer';
import { CsvRenderer } from '@/components/file-renderers/csv-renderer';
import { XlsxRenderer } from '@/components/file-renderers/xlsx-renderer';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { CodeBlockCode } from '@/components/ui/code-block';
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
  extractFileEditData,
  type FileOperation,
  type OperationConfig,
} from './_utils';
import { ToolViewProps } from '../types';
import { GenericToolView } from '../GenericToolView';
import { LoadingState } from '../shared/LoadingState';
import { toast } from 'sonner';

export function FileOperationToolView({
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  name,
  project,
  onFileClick,
}: ToolViewProps) {
  const { resolvedTheme } = useTheme();
  const isDarkTheme = resolvedTheme === 'dark';

  // Add copy functionality state
  const [isCopyingContent, setIsCopyingContent] = useState(false);

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

  const operation = getOperationType(name, assistantContent);
  const configs = getOperationConfigs();
  const config = configs[operation];
  const Icon = config.icon;

  let filePath: string | null = null;
  let fileContent: string | null = null;

  // For edit operations, use extractFileEditData to get updated content
  if (operation === 'edit') {
    const editData = extractFileEditData(
      assistantContent,
      toolContent,
      isSuccess,
      toolTimestamp,
      assistantTimestamp
    );
    filePath = editData.filePath;
    fileContent = editData.updatedContent; // Use updated content for display
  } else {
    // For other operations, use standard extraction
    const assistantToolData = extractToolData(assistantContent);
    const toolToolData = extractToolData(toolContent);

    if (assistantToolData.toolResult) {
      filePath = assistantToolData.filePath;
      fileContent = assistantToolData.fileContent;
    } else if (toolToolData.toolResult) {
      filePath = toolToolData.filePath;
      fileContent = toolToolData.fileContent;
    }

    if (!filePath) {
      filePath = extractFilePath(assistantContent);
    }

    if (!fileContent && operation !== 'delete') {
      fileContent = isStreaming
        ? extractStreamingFileContent(
          assistantContent,
          operation === 'create' ? 'create-file' : 'full-file-rewrite',
        ) || ''
        : extractFileContent(
          assistantContent,
          operation === 'create' ? 'create-file' : 'full-file-rewrite',
        );
    }
  }

  const toolTitle = getToolTitle(name || `file-${operation}`);
  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);

  const isMarkdown = isFileType.markdown(fileExtension);
  const isHtml = isFileType.html(fileExtension);
  const isCsv = isFileType.csv(fileExtension);
  const isXlsx = isFileType.xlsx(fileExtension);

  const language = getLanguageFromFileName(fileName);
  const hasHighlighting = hasLanguageHighlighting(language);
  const contentLines = splitContentIntoLines(fileContent);

  const htmlPreviewUrl =
    isHtml && project?.sandbox?.sandbox_url && processedFilePath
      ? constructHtmlPreviewUrl(project.sandbox.sandbox_url, processedFilePath)
      : undefined;

  const FileIcon = getFileIcon(fileName);

  if (!isStreaming && !processedFilePath && !fileContent) {
    return (
      <GenericToolView
        name={name || `file-${operation}`}
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
        isStreaming={isStreaming}
      />
    );
  }

  const renderFilePreview = () => {
    if (!fileContent) {
      return (
        <div className="flex items-center justify-center h-full p-12">
          <div className="text-center">
            <FileIcon className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No content to preview</p>
          </div>
        </div>
      );
    }

    if (isHtml && htmlPreviewUrl) {
      return (
        <div className="w-full h-full">
          <iframe
            src={htmlPreviewUrl}
            title={`HTML Preview of ${fileName}`}
            className="w-full h-full border-0"
            sandbox="allow-same-origin allow-scripts"
          />
        </div>
      );
    }

    if (isMarkdown) {
      return (
        <div className="p-6 prose dark:prose-invert prose-zinc max-w-none prose-headings:font-semibold">
          <MarkdownRenderer
            content={processUnicodeContent(fileContent)}
            project={project}
            basePath={processedFilePath || undefined}
          />
        </div>
      );
    }

    if (isCsv) {
      return (
        <div className="p-6 flex flex-col">
          <div className="flex-1 min-h-[400px] w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
            <CsvRenderer content={processUnicodeContent(fileContent)} />
          </div>
        </div>
      );
    }

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

    return (
      <div className="p-6">
        <div className='w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6'>
          <div className="text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
            {processUnicodeContent(fileContent)}
          </div>
        </div>
      </div>
    );
  };

  const renderDeleteOperation = () => (
    <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
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
        <div className="flex items-center justify-center h-full p-12">
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
      <div className="min-w-full table">
        {allLines.map((line, idx) => (
          <div
            key={idx}
            className={cn("table-row transition-colors", config.hoverColor)}
          >
            <div className="table-cell text-right pr-4 pl-4 py-0.5 text-xs text-zinc-400 dark:text-zinc-600 select-none w-14 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
              {idx + 1}
            </div>
            <div className="table-cell pl-4 py-0.5 pr-4 text-[15px] leading-relaxed whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">
              {line ? processUnicodeContent(line, true) : ' '}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <Tabs defaultValue="preview" className="w-full h-full">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2 mb-0">
          <div className="flex flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className={cn("relative p-2 rounded-lg border flex-shrink-0", config.gradientBg, config.borderColor)}>
                <Icon className={cn("h-5 w-5", config.color)} />
              </div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {toolTitle}
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
              {fileContent && !isStreaming && (
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
              {isHtml && htmlPreviewUrl && !isStreaming && (
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Open in browser" asChild>
                  <a href={htmlPreviewUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              )}
              {processedFilePath && onFileClick && !isStreaming && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onFileClick(processedFilePath)}
                  className="h-8 w-8 p-0"
                  title="Open in workspace manager"
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0 -my-2 h-full flex-1 overflow-hidden relative">
          <TabsContent value="code" className="flex-1 h-full mt-0 p-0 overflow-hidden">
            <ScrollArea className="h-full w-full min-h-0">
              {isStreaming && !fileContent ? (
                <LoadingState
                  icon={Icon}
                  iconColor={config.color}
                  bgColor={config.bgColor}
                  title={config.progressMessage}
                  filePath={processedFilePath || 'Processing file...'}
                  subtitle="Please wait while the file is being processed"
                  showProgress={false}
                />
              ) : operation === 'delete' ? (
                <div className="flex flex-col items-center justify-center h-full py-12 px-6">
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

          <TabsContent value="preview" className="w-full flex-1 h-full mt-0 p-0 overflow-hidden">
            {isHtml && htmlPreviewUrl ? (
              // For HTML files, render iframe directly without ScrollArea for full viewport
              <div className="w-full h-full relative">
                {renderFilePreview()}
                {isStreaming && fileContent && (
                  <div className="absolute bottom-4 right-4 z-10">
                    <Badge className="bg-blue-500/90 text-white border-none shadow-lg animate-pulse">
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      Streaming...
                    </Badge>
                  </div>
                )}
              </div>
            ) : (
              // For non-HTML files, use ScrollArea as before
              <ScrollArea className="h-full w-full min-h-0">
                {isStreaming && !fileContent ? (
                  <LoadingState
                    icon={Icon}
                    iconColor={config.color}
                    bgColor={config.bgColor}
                    title={config.progressMessage}
                    filePath={processedFilePath || 'Processing file...'}
                    subtitle="Please wait while the file is being processed"
                    showProgress={false}
                  />
                ) : operation === 'delete' ? (
                  renderDeleteOperation()
                ) : (
                  renderFilePreview()
                )}
                {isStreaming && fileContent && (
                  <div className="sticky bottom-4 right-4 float-right mr-4 mb-4">
                    <Badge className="bg-blue-500/90 text-white border-none shadow-lg animate-pulse">
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      Streaming...
                    </Badge>
                  </div>
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