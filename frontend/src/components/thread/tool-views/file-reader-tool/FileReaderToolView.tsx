import React, { useState } from 'react';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  Copy,
  ChevronDown,
  ChevronRight,
  FileType,
  Files,
  Check,
  Search,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { truncateString, cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadingState } from '../shared/LoadingState';
import { extractFileReaderData, formatFileSize, FileReadResult, SearchHit } from './_utils';

function SearchResultCard({ hit, index }: { hit: SearchHit; index: number }) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  
  const filename = hit.file.split('/').pop() || hit.file;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(hit.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <Card className="overflow-hidden transition-all duration-200 hover:bg-muted/20">
      <div
        className="flex items-center gap-3 px-4 cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {expanded
            ? <ChevronDown className="w-4 h-4 text-zinc-400 flex-shrink-0" />
            : <ChevronRight className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          }
          <FileText className="w-4 h-4 text-blue-500" />
          <span className="font-medium text-sm truncate text-zinc-900 dark:text-zinc-100">
            {filename}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={(e) => { e.stopPropagation(); copyToClipboard(); }}>
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy content</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      {expanded && (
        <div>
          <div className="overflow-auto">
            <pre className="px-4 pb-4 -pt-2 text-sm whitespace-pre-wrap break-words text-muted-foreground">
              {hit.content}
            </pre>
          </div>
        </div>
      )}
    </Card>
  );
}

function FileResultCard({ result, defaultExpanded = false }: { result: FileReadResult; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const filename = result.file_path.split('/').pop() || result.file_path;
  const hasContent = result.success && result.content;

  const copyToClipboard = async () => {
    if (!result.content) return;
    try {
      await navigator.clipboard.writeText(result.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getFileIcon = () => {
    switch (result.file_type) {
      case 'pdf':
        return <FileType className="w-4 h-4 text-red-500" />;
      case 'doc':
      case 'docx':
        return <FileType className="w-4 h-4 text-blue-500" />;
      default:
        return <FileText className="w-4 h-4 text-zinc-500" />;
    }
  };

  return (
    <Card className={cn(
      "overflow-hidden transition-all duration-200",
    )}>
      <div
        className={cn(
          "flex items-center gap-3 p-3 cursor-pointer transition-colors",
          hasContent ? "hover:bg-zinc-50 dark:hover:bg-zinc-800/50" : "",
        )}
        onClick={() => hasContent && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {hasContent && (
            expanded
              ? <ChevronDown className="w-4 h-4 text-zinc-400 flex-shrink-0" />
              : <ChevronRight className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          )}
          {!hasContent && <div className="w-4" />}

          {getFileIcon()}

          <span className="font-medium text-sm truncate text-zinc-900 dark:text-zinc-100">
            {filename}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {result.success ? (
            <>
              {result.file_type && (
                <Badge variant="outline" className="text-xs uppercase">
                  {result.file_type}
                </Badge>
              )}
              {result.content_length !== undefined && (
                <Badge variant="secondary" className="text-xs">
                  {result.content_length.toLocaleString()} chars
                </Badge>
              )}
              {result.truncated && (
                <Badge variant="outline" className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700">
                  Truncated
                </Badge>
              )}
              <CheckCircle className="w-4 h-4 text-emerald-500" />
            </>
          ) : (
            <>
              <span className="text-xs text-red-600 dark:text-red-400 max-w-[200px] truncate">
                {result.error || 'Failed to read'}
              </span>
              <AlertTriangle className="w-4 h-4 text-red-500" />
            </>
          )}
        </div>
      </div>

      {expanded && hasContent && (
        <div>
          <div className="flex items-center justify-between px-3 py-2 bg-zinc-100/50 dark:bg-zinc-800/50">
            <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              {result.extraction_method && (
                <span>Extracted via {result.extraction_method}</span>
              )}
              {result.size_bytes !== undefined && (
                <>
                  <span>•</span>
                  <span>{formatFileSize(result.size_bytes)}</span>
                </>
              )}
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyToClipboard();
                    }}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span className="ml-1.5 text-xs">{copied ? 'Copied!' : 'Copy'}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy content to clipboard</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="h-[400px] overflow-auto">
            <pre className="px-4 pb-4 text-sm whitespace-pre-wrap break-words text-muted-foreground">
              {result.content}
            </pre>
          </div>
        </div>
      )}
    </Card>
  );
}

export function FileReaderToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  if (!toolCall) {
    console.warn('FileReaderToolView: toolCall is undefined.');
    return null;
  }

  const {
    filePaths,
    isBatch,
    isSearch,
    searchData,
    results,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractFileReaderData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  
  const displayTitle = isSearch
    ? `Search: "${truncateString(searchData?.query || '', 25)}"`
    : isBatch
      ? `Reading ${filePaths.length} files`
      : truncateString(filePaths[0]?.split('/').pop() || 'File', 30);

  const iconBgClass = isSearch ? "bg-blue-500/20 border-blue-500/20" : "bg-emerald-500/20 border-emerald-500/20";
  const iconTextClass = isSearch ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400";

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn("relative p-2 rounded-xl border", iconBgClass)}>
              {isSearch ? (
                <Search className={cn("w-5 h-5", iconTextClass)} />
              ) : isBatch ? (
                <Files className={cn("w-5 h-5", iconTextClass)} />
              ) : (
                <FileText className={cn("w-5 h-5", iconTextClass)} />
              )}
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {displayTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <div className="flex items-center gap-2">
              {isSearch && searchData ? (
                <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                  <Search className="h-3 w-3 mr-1" />
                  {searchData.totalHits} results
                </Badge>
              ) : isBatch && results.length > 0 ? (
                <div className="flex items-center gap-1.5 text-xs">
                  {successCount > 0 && (
                    <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      {successCount}
                    </Badge>
                  )}
                  {failCount > 0 && (
                    <Badge variant="secondary" className="bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {failCount}
                    </Badge>
                  )}
                </div>
              ) : !isBatch && (
                <Badge
                  variant="secondary"
                  className={
                    actualIsSuccess
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                      : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                  }
                >
                  {actualIsSuccess ? (
                    <>
                      <CheckCircle className="h-3.5 w-3.5 mr-1" />
                      Read
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                      Failed
                    </>
                  )}
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={isSearch ? Search : FileText}
            iconColor={isSearch ? "text-blue-500 dark:text-blue-400" : "text-emerald-500 dark:text-emerald-400"}
            bgColor={isSearch ? "bg-blue-500/10" : "bg-emerald-500/10"}
            title={isSearch ? 'Searching files...' : isBatch ? `Reading ${filePaths.length} files...` : 'Reading file...'}
            filePath={isSearch ? searchData?.query : isBatch ? `${filePaths.length} files` : filePaths[0]}
            showProgress={true}
          />
        ) : isSearch && searchData ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-3">
              {searchData.results.length > 0 ? (
                searchData.results.map((hit, idx) => (
                  <SearchResultCard key={`${hit.file}-${idx}`} hit={hit} index={idx} />
                ))
              ) : (
                <div className="text-center py-8 text-zinc-500">
                  No matching content found
                </div>
              )}
            </div>
          </ScrollArea>
        ) : results.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-3">
              {results.map((result, idx) => (
                <FileResultCard
                  key={result.file_path + idx}
                  result={result}
                  defaultExpanded={results.length === 1}
                />
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-muted/20">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center mb-4">
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No Results</h3>
            <p className="text-sm text-muted-foreground text-center">
              {filePaths.length > 0
                ? `Waiting to process: ${filePaths.join(', ')}`
                : 'No file path specified'}
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-muted/30 backdrop-blur-sm border-t flex justify-between items-center gap-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn(
            "text-xs",
            isSearch 
              ? "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800"
              : "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800"
          )}>
            {isSearch ? <Search className="h-3 w-3 mr-1" /> : <FileText className="h-3 w-3 mr-1" />}
            {isSearch ? 'File Search' : 'File Reader'}
          </Badge>
          {!isSearch && isBatch && results.length > 0 && (
            <Badge variant="outline" className="text-xs">
              {results.length} file{results.length !== 1 ? 's' : ''}
            </Badge>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          {actualToolTimestamp && !isStreaming
            ? formatTimestamp(actualToolTimestamp)
            : actualAssistantTimestamp
              ? formatTimestamp(actualAssistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}

