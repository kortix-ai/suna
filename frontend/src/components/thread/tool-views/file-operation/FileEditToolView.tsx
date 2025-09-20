import React, { useState } from 'react';
import {
  FileDiff,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Loader2,
  Code,
  Eye,
  File,
  Copy,
  Check,
  Minus,
  Plus,
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
} from '@/components/file-renderers/markdown-renderer';
import { CsvRenderer } from '@/components/file-renderers/csv-renderer';
import { XlsxRenderer } from '@/components/file-renderers/xlsx-renderer';
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
import {
  extractFileEditData,
  generateLineDiff,
  calculateDiffStats,
  LineDiff,
  DiffStats,
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
  type FileOperation,
  type OperationConfig,
} from './_utils';
import { ToolViewProps } from '../types';
import { GenericToolView } from '../GenericToolView';
import { LoadingState } from '../shared/LoadingState';
import { toast } from 'sonner';
import ReactDiffViewer from 'react-diff-viewer-continued';

const UnifiedDiffView: React.FC<{ oldCode: string; newCode: string }> = ({ oldCode, newCode }) => (
  <ReactDiffViewer
    oldValue={oldCode}
    newValue={newCode}
    splitView={false}
    hideLineNumbers={true}
    showDiffOnly={false}
    useDarkTheme={document.documentElement.classList.contains('dark')}
    styles={{
      variables: {
        dark: {
          diffViewerColor: '#e2e8f0',
          diffViewerBackground: '#09090b',
          addedBackground: '#104a32',
          addedColor: '#6ee7b7',
          removedBackground: '#5c1a2e',
          removedColor: '#fca5a5',
        },
      },
      diffContainer: {
        backgroundColor: 'var(--card)',
        border: 'none',
      },
      diffRemoved: {
        display: 'none',
      },
      line: {
        fontFamily: 'monospace',
      },
    }}
  />
);

const ErrorState: React.FC<{ message?: string }> = ({ message }) => (
  <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
    <div className="text-center w-full max-w-xs">
      <AlertTriangle className="h-16 w-16 mx-auto mb-6 text-amber-500" />
      <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-100 mb-2">
        Invalid File Edit
      </h3>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {message || "Could not extract the file changes from the tool result."}
      </p>
    </div>
  </div>
);

export function FileEditToolView({
  name = 'edit-file',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps): JSX.Element {
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
    if (!updatedContent) return;

    setIsCopyingContent(true);
    const success = await copyToClipboard(updatedContent);
    if (success) {
      toast.success('File content copied to clipboard');
    } else {
      toast.error('Failed to copy file content');
    }
    setTimeout(() => setIsCopyingContent(false), 500);
  };

  const operation = getOperationType(name, assistantContent);
  const configs = getOperationConfigs();
  const config = configs[operation] || configs['edit']; // fallback to edit config
  const Icon = FileDiff; // Always use FileDiff for edit operations

  const {
    filePath,
    originalContent,
    updatedContent,
    actualIsSuccess,
    actualToolTimestamp,
    errorMessage,
  } = extractFileEditData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);
  const processedFilePath = processFilePath(filePath);
  const fileName = getFileName(processedFilePath);
  const fileExtension = getFileExtension(fileName);

  const isMarkdown = isFileType.markdown(fileExtension);
  const isHtml = isFileType.html(fileExtension);
  const isCsv = isFileType.csv(fileExtension);
  const isXlsx = isFileType.xlsx(fileExtension);

  const language = getLanguageFromFileName(fileName);
  const hasHighlighting = hasLanguageHighlighting(language);
  const contentLines = splitContentIntoLines(updatedContent);

  const htmlPreviewUrl =
    isHtml && project?.sandbox?.sandbox_url && processedFilePath
      ? constructHtmlPreviewUrl(project.sandbox.sandbox_url, processedFilePath)
      : undefined;

  const FileIcon = getFileIcon(fileName);

  const lineDiff = originalContent && updatedContent ? generateLineDiff(originalContent, updatedContent) : [];
  const stats: DiffStats = calculateDiffStats(lineDiff);

  const shouldShowError = !isStreaming && (!actualIsSuccess || (actualIsSuccess && (originalContent === null || updatedContent === null)));

  if (!isStreaming && !processedFilePath && !updatedContent) {
    return (
      <GenericToolView
        name={name || 'edit-file'}
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
    if (!updatedContent) {
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
        <div className="flex flex-col h-[calc(100vh-16rem)]">
          <iframe
            src={htmlPreviewUrl}
            title={`HTML Preview of ${fileName}`}
            className="flex-grow border-0"
            sandbox="allow-same-origin allow-scripts"
          />
        </div>
      );
    }

    if (isMarkdown) {
      return (
        <div className="p-1 py-0 prose dark:prose-invert prose-zinc max-w-none">
          <MarkdownRenderer
            content={processUnicodeContent(updatedContent)}
            project={project}
            basePath={processedFilePath || undefined}
          />
        </div>
      );
    }

    if (isCsv) {
      return (
        <div className="h-full w-full p-4">
          <div className="h-[calc(100vh-17rem)] w-full bg-muted/20 border rounded-xl overflow-auto">
            <CsvRenderer content={processUnicodeContent(updatedContent)} />
          </div>
        </div>
      );
    }

    if (isXlsx) {
      return (
        <div className="h-full w-full p-4">
          <div className="h-[calc(100vh-17rem)] w-full bg-muted/20 border rounded-xl overflow-auto">
            <XlsxRenderer 
              content={updatedContent}
              filePath={processedFilePath}
              fileName={fileName}
              project={project}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="p-4">
        <div className='w-full h-full bg-muted/20 border rounded-xl px-4 py-2 pb-6'>
          <pre className="text-sm font-mono text-zinc-800 dark:text-zinc-300 whitespace-pre-wrap break-words">
            {processUnicodeContent(updatedContent)}
          </pre>
        </div>
      </div>
    );
  };

  const renderSourceCode = () => {
    if (!originalContent || !updatedContent) {
      return (
        <div className="flex items-center justify-center h-full p-12">
          <div className="text-center">
            <FileIcon className="h-12 w-12 mx-auto mb-4 text-zinc-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No diff to display</p>
          </div>
        </div>
      );
    }

    // Show unified diff view in source tab
    return (
      <div className="flex-1 overflow-auto min-h-0 text-xs">
        <UnifiedDiffView oldCode={originalContent} newCode={updatedContent} />
      </div>
    );
  };

  return (
    <Card className="flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <Tabs defaultValue={isMarkdown || isHtml || isCsv || isXlsx ? 'preview' : 'code'} className="w-full h-full">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2 mb-0">
          <div className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
                <FileDiff className="w-5 h-5 text-blue-500 dark:text-blue-400" />
              </div>
              <div>
                <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                  {toolTitle}
                </CardTitle>
              </div>
            </div>
            <div className='flex items-center gap-2'>
              {isHtml && htmlPreviewUrl && !isStreaming && (
                <Button variant="outline" size="sm" className="h-8 text-xs bg-white dark:bg-muted/50 hover:bg-zinc-100 dark:hover:bg-zinc-800 shadow-none" asChild>
                  <a href={htmlPreviewUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Open in Browser
                  </a>
                </Button>
              )}
              {/* Copy button - only show when there's file content */}
              {updatedContent && !isStreaming && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyContent}
                  disabled={isCopyingContent}
                  className="h-8 text-xs bg-white dark:bg-muted/50 hover:bg-zinc-100 dark:hover:bg-zinc-800 shadow-none"
                  title="Copy file content"
                >
                  {isCopyingContent ? (
                    <Check className="h-3.5 w-3.5 mr-1.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  <span className="hidden sm:inline">Copy</span>
                </Button>
              )}
              {/* Diff mode selector for source tab */}
              {originalContent && updatedContent && (
                <div className="flex items-center gap-2">
                  <div className="flex items-center text-xs text-zinc-500 dark:text-zinc-400 gap-3">
                    {stats.additions === 0 && stats.deletions === 0 && (
                      <Badge variant="outline" className="text-xs font-normal">No changes</Badge>
                    )}
                  </div>
                </div>
              )}
              <TabsList className="h-8 bg-muted/50 border border-border/50 p-0.5 gap-1">
                <TabsTrigger
                  value="code"
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-all [&[data-state=active]]:bg-white [&[data-state=active]]:dark:bg-primary/10 [&[data-state=active]]:text-foreground hover:bg-background/50 text-muted-foreground shadow-none"
                >
                  <Code className="h-3.5 w-3.5" />
                  Source
                </TabsTrigger>
                <TabsTrigger
                  value="preview"
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-all [&[data-state=active]]:bg-white [&[data-state=active]]:dark:bg-primary/10 [&[data-state=active]]:text-foreground hover:bg-background/50 text-muted-foreground shadow-none"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Preview
                </TabsTrigger>
              </TabsList>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0 flex-1 overflow-auto">
          <TabsContent value="code" className="mt-0 p-0">
            {isStreaming && !updatedContent ? (
              <LoadingState
                icon={FileDiff}
                iconColor="text-blue-500 dark:text-blue-400"
                bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
                title="Applying File Edit"
                filePath={processedFilePath || 'Processing file...'}
                subtitle="Please wait while the file is being modified"
                showProgress={false}
              />
            ) : shouldShowError ? (
              <ErrorState message={errorMessage} />
            ) : (
              renderSourceCode()
            )}
          </TabsContent>

          <TabsContent value="preview" className="mt-0 p-0">
            {isStreaming && !updatedContent ? (
              <LoadingState
                icon={FileDiff}
                iconColor="text-blue-500 dark:text-blue-400"
                bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
                title="Applying File Edit"
                filePath={processedFilePath || 'Processing file...'}
                subtitle="Please wait while the file is being modified"
                showProgress={false}
              />
            ) : shouldShowError ? (
              <ErrorState message={errorMessage} />
            ) : (
              renderFilePreview()
            )}
            {isStreaming && updatedContent && (
              <div className="sticky bottom-4 right-4 float-right mr-4 mb-4">
                <Badge className="bg-blue-500/90 text-white border-none shadow-lg animate-pulse">
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  Streaming...
                </Badge>
              </div>
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
            {actualToolTimestamp && !isStreaming
              ? formatTimestamp(actualToolTimestamp)
              : assistantTimestamp
                ? formatTimestamp(assistantTimestamp)
                : ''}
          </div>
        </div>
      </Tabs>
    </Card>
  );
}