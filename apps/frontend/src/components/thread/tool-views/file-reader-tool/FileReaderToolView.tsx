import React, { useState } from 'react';
import {
  FileText,
  AlertTriangle,
  Copy,
  Files,
  CheckCircle2,
  Search,
  FileCode,
  FileImage,
  FileSpreadsheet,
  File,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ToolViewHeader } from '../shared/ToolViewHeader';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { getToolTitle } from '../utils';
import { extractFileReaderData, FileReadResult, SearchHit } from './_utils';
import { toast } from '@/lib/toast';

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (['pdf'].includes(ext)) return FileText;
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return FileImage;
  if (['csv', 'xlsx', 'xls'].includes(ext)) return FileSpreadsheet;
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'json'].includes(ext)) return FileCode;
  return File;
};

const getFileExtension = (filename: string) => {
  const trimmed = filename.trim();
  return trimmed.split('.').pop()?.toUpperCase() || '';
};

function SingleFileView({ result }: { result: FileReadResult }) {
  const [copied, setCopied] = useState(false);
  const rawFilename = result.file_path.split('/').pop() || result.file_path;
  const filename = rawFilename.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '');
  const fileExt = getFileExtension(filename);
  const FileIcon = getFileIcon(filename);

  const copyToClipboard = async () => {
    if (!result.content) return;
    try {
      await navigator.clipboard.writeText(result.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  if (!result.success) {
    return (
      <div className="flex items-center gap-4 p-4">
        <div className="relative flex-shrink-0">
          <div className="w-12 h-12 rounded-xl bg-red-50 dark:bg-red-950/30 flex items-center justify-center border border-red-100 dark:border-red-900/50">
            <AlertTriangle className="h-5 w-5 text-red-500 dark:text-red-400" />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {filename}
          </p>
          <p className="text-xs text-red-500 dark:text-red-400 mt-0.5 line-clamp-2">
            {result.error || 'Failed to read file'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 space-y-4">
      {/* File Header */}
      <div className="flex items-start gap-4 flex-shrink-0">
        <div className="relative flex-shrink-0">
          <div className="w-12 h-12 rounded-xl bg-zinc-50 dark:bg-zinc-900/30 flex items-center justify-center border border-zinc-100 dark:border-zinc-800/50">
            <FileIcon className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
          </div>
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-zinc-500 flex items-center justify-center shadow-sm">
            <CheckCircle2 className="h-3 w-3 text-white" />
          </div>
        </div>
        
        <div className="flex-1 min-w-0 space-y-2">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {filename}
            </p>
            <div className="flex items-center gap-2 mt-1">
              {fileExt && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                  {fileExt}
                </Badge>
              )}
              {result.content_length !== undefined && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {result.content_length.toLocaleString()} chars
                </span>
              )}
              {result.truncated && (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-zinc-600 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700">
                  Truncated
                </Badge>
              )}
            </div>
          </div>
          
          {result.content && (
            <Button
              variant="ghost"
              size="sm"
              onClick={copyToClipboard}
              className={cn(
                "h-8 text-xs transition-colors",
                copied && "text-zinc-600 dark:text-zinc-400"
              )}
            >
              {copied ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                  Copy Content
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* File Content - Takes remaining space */}
      {result.content && (
        <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden flex-1 min-h-0">
          <ScrollArea className="h-full w-full">
            <pre className="px-4 py-3 text-sm whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300 font-mono">
              {result.content}
            </pre>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function BatchFileView({ results }: { results: FileReadResult[] }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(results.length === 1 ? 0 : null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyToClipboard = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <div className="p-4 space-y-2">
      {results.map((result, idx) => {
        const rawFilename = result.file_path.split('/').pop() || result.file_path;
        const filename = rawFilename.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '');
        const FileIcon = getFileIcon(filename);
        const isExpanded = expandedIndex === idx;

        return (
          <div
            key={result.file_path + idx}
            className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
          >
            <div
              className="flex items-center gap-3 px-4 py-3 cursor-pointer"
              onClick={() => setExpandedIndex(isExpanded ? null : idx)}
            >
              <FileIcon className="h-4 w-4 text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                  {filename}
                </p>
                {result.success && result.content_length !== undefined && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {result.content_length.toLocaleString()} chars
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {result.success ? (
                  <CheckCircle2 className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                )}
              </div>
            </div>
            
            {isExpanded && result.content && (
              <div className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
                <div className="p-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                    Content
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyToClipboard(result.content!, idx);
                    }}
                    className={cn(
                      "h-7 text-xs",
                      copiedIndex === idx && "text-zinc-600 dark:text-zinc-400"
                    )}
                  >
                    {copiedIndex === idx ? (
                      <>
                        <CheckCircle2 className="h-3 w-3 mr-1.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3 mr-1.5" />
                        Copy
                      </>
                    )}
                  </Button>
                </div>
                <ScrollArea className="h-[400px] w-full">
                  <pre className="px-4 py-3 text-sm whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300 font-mono">
                    {result.content}
                  </pre>
                </ScrollArea>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SearchResultsView({ hits }: { hits: SearchHit[] }) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyToClipboard = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <div className="p-4 space-y-3">
      {hits.map((hit, idx) => {
        const rawFilename = hit.file.split('/').pop() || hit.file;
        const filename = rawFilename.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '');
        const FileIcon = getFileIcon(filename);

        return (
          <div
            key={`${hit.file}-${idx}`}
            className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
          >
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-zinc-50 dark:bg-zinc-900/30 flex items-center justify-center border border-zinc-100 dark:border-zinc-800/50 flex-shrink-0">
                  <FileIcon className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                </div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate flex-1">
                  {filename}
                </p>
                {hit.score > 0 && (
                  <Badge variant="outline" className="text-xs bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700">
                    {hit.score.toFixed(2)}
                  </Badge>
                )}
              </div>
              
              <div className="bg-zinc-50 dark:bg-zinc-900 rounded border border-zinc-200 dark:border-zinc-800 p-3">
                <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
                  {hit.content}
                </p>
              </div>
              
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(hit.content, idx)}
                className={cn(
                  "h-8 text-xs w-full transition-colors",
                  copiedIndex === idx && "text-zinc-600 dark:text-zinc-400"
                )}
              >
                {copiedIndex === idx ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5 mr-1.5" />
                    Copy Content
                  </>
                )}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
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

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);

  const getCleanFileName = (filePath: string) => {
    const raw = filePath.split('/').pop() || filePath;
    return raw.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '');
  };

  const displayTitle = isSearch
    ? searchData?.query || 'File Search'
    : isBatch
      ? `${filePaths.length} files`
      : getCleanFileName(filePaths[0] || 'File');

  const HeaderIcon = isSearch ? Search : isBatch ? Files : FileText;
  const successCount = results.filter(r => r.success).length;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <ToolViewHeader icon={HeaderIcon} title={toolTitle}>
        {!isStreaming && isSearch && searchData && (
          <Badge variant="outline" className="text-xs font-normal bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700">
            <Search className="h-3 w-3 mr-1" />
            {searchData.totalHits} {searchData.totalHits === 1 ? 'result' : 'results'}
          </Badge>
        )}
        {!isStreaming && isBatch && results.length > 0 && (
          <Badge variant="outline" className="text-xs font-normal">
            {successCount}/{results.length} successful
          </Badge>
        )}
      </ToolViewHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex items-center gap-4 p-4">
            <div className="relative">
              <div className="w-12 h-12 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                <HeaderIcon className="h-5 w-5 text-zinc-400" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-white dark:bg-zinc-900 flex items-center justify-center shadow-sm border border-zinc-200 dark:border-zinc-700">
                <KortixLoader customSize={12} />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {displayTitle}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {isSearch ? 'Searching...' : isBatch ? `Reading ${filePaths.length} files...` : 'Reading file...'}
              </p>
            </div>
          </div>
        ) : isSearch && searchData ? (
          searchData.results.length > 0 ? (
            <ScrollArea className="h-full w-full">
              <SearchResultsView hits={searchData.results} />
            </ScrollArea>
          ) : (
            <div className="flex flex-col items-center justify-center h-full py-12 px-6">
              <div className="w-16 h-16 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-4">
                <Search className="h-8 w-8 text-zinc-400" />
              </div>
              <h3 className="text-lg font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
                No results found
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center">
                No matching content found for "{searchData.query}"
              </p>
            </div>
          )
        ) : results.length > 0 ? (
          results.length === 1 ? (
            <div className="h-full flex flex-col">
              <SingleFileView result={results[0]} />
            </div>
          ) : (
            <ScrollArea className="h-full w-full">
              <BatchFileView results={results} />
            </ScrollArea>
          )
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <div className="w-16 h-16 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-4">
              <FileText className="h-8 w-8 text-zinc-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No results
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center">
              {filePaths.length > 0
                ? `Waiting to process: ${filePaths.map(getCleanFileName).join(', ')}`
                : 'No file path specified'}
            </p>
          </div>
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={actualAssistantTimestamp || undefined}
        toolTimestamp={actualToolTimestamp || undefined}
        isStreaming={isStreaming}
      >
        {!isStreaming && results.length > 0 && (
          <Badge variant="outline" className="h-6 py-0.5 bg-zinc-100 dark:bg-zinc-800">
            {isSearch ? (
              <>
                <Search className="h-3 w-3 mr-1 text-zinc-600 dark:text-zinc-400" />
                <span className="text-zinc-600 dark:text-zinc-400">Search</span>
              </>
            ) : (
              <>
                <FileText className="h-3 w-3 mr-1 text-zinc-600 dark:text-zinc-400" />
                <span className="text-zinc-600 dark:text-zinc-400">
                  {results.length === 1 ? 'Read' : `${results.length} files`}
                </span>
              </>
            )}
          </Badge>
        )}
      </ToolViewFooter>
    </Card>
  );
}

