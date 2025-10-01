import React from 'react';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  Copy,
  FileSpreadsheet,
  List,
  BookOpen,
  Hash,
  FileX,
  ExternalLink
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { truncateString } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { LoadingState } from '../shared/LoadingState';
import { extractDocumentParserData } from './_utils';
import { cn } from '@/lib/utils';

export function DocumentParserToolView({
  name = 'parse-document',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const {
    url,
    message,
    result,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractDocumentParserData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getFileIcon = (url: string | null) => {
    if (!url) return <FileText className="w-4 h-4" />;
    
    const ext = url.toLowerCase().split('.').pop();
    switch (ext) {
      case 'pdf': return <FileText className="w-4 h-4" />;
      case 'doc':
      case 'docx': return <FileText className="w-4 h-4" />;
      case 'xls':
      case 'xlsx': return <FileSpreadsheet className="w-4 h-4" />;
      default: return <FileText className="w-4 h-4" />;
    }
  };

  const hasContent = result.text_content.length > 0 || result.structure.length > 0 || result.tables.length > 0;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-indigo-500/20 border border-indigo-500/20">
              <FileText className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className={
                  actualIsSuccess
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                    : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                }
              >
                {actualIsSuccess ? (
                  <CheckCircle className="h-3.5 w-3.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
                {actualIsSuccess ? 'Parse completed' : 'Parse failed'}
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && !hasContent ? (
          <LoadingState
            icon={FileText}
            iconColor="text-primary"
            bgColor="bg-primary/10"
            title="Processing document"
            filePath={url}
            showProgress={true}
          />
        ) : hasContent ? (
          <ScrollArea className="h-full w-full">
            <div className="sticky top-0 z-10 bg-neutral-100 dark:bg-neutral-900 border-b p-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="flex items-center gap-2">
                  <div className='h-8 w-8 flex items-center justify-center bg-muted rounded-lg border'>
                    <Hash className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Pages</p>
                    <p className="text-sm font-medium">{result.summary.total_pages}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className='h-8 w-8 flex items-center justify-center bg-muted rounded-lg border'>
                    <List className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Sections</p>
                    <p className="text-sm font-medium">{result.summary.text_sections}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className='h-8 w-8 flex items-center justify-center bg-muted rounded-lg border'>
                    <BookOpen className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Headings</p>
                    <p className="text-sm font-medium">{result.summary.headings_count}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className='h-8 w-8 flex items-center justify-center bg-muted rounded-lg border'>
                    <FileSpreadsheet className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Tables</p>
                    <p className="text-sm font-medium">{result.summary.tables_count}</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="pb-4">
              <TooltipProvider>
                <div className="p-4 space-y-6">
                  {result.text_content.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <FileText className="w-4 h-4 text-muted-foreground" />
                        <h4 className="font-medium">Content</h4>
                        <Badge variant="secondary" className="text-xs">
                          {result.text_content.length} sections
                        </Badge>
                      </div>
                      <div className="space-y-4">
                        {result.text_content.map((item, idx) => (
                          <Card key={idx} className="p-4">
                            <div className="flex items-center justify-between">
                              <Badge variant="outline" className="text-xs">
                                Section {idx + 1} • Page {item.page}
                              </Badge>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    onClick={() => copyToClipboard(item.text)}
                                  >
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Copy text</TooltipContent>
                              </Tooltip>
                            </div>
                            <div className="bg-muted/70 rounded-md p-3">
                              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                {item.text}
                              </p>
                            </div>
                          </Card>
                        ))}
                      </div>
                      {result.tables.length > 0 && <Separator className="my-6" />}
                    </div>
                  )}
                  {result.tables.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <FileSpreadsheet className="w-4 h-4 text-muted-foreground" />
                        <h4 className="font-medium">Tables</h4>
                        <Badge variant="secondary" className="text-xs">
                          {result.tables.length} found
                        </Badge>
                      </div>
                      <div className="space-y-4">
                        {result.tables.map((table, idx) => (
                          <Card key={idx} className="p-4">
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">Table {idx + 1}</span>
                                <Badge variant="outline" className="text-xs">
                                  Page {table.page}
                                </Badge>
                              </div>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    onClick={() => copyToClipboard(table.content)}
                                  >
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Copy table</TooltipContent>
                              </Tooltip>
                            </div>
                            <div className="bg-muted/50 rounded-md p-3">
                              {table.html ? (
                                <div 
                                  className="text-sm overflow-x-auto"
                                  dangerouslySetInnerHTML={{ __html: table.html }}
                                />
                              ) : (
                                <pre className="text-sm whitespace-pre-wrap font-mono">
                                  {table.content}
                                </pre>
                              )}
                            </div>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </TooltipProvider>
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-muted/20">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center mb-4">
              <FileX className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              No Content Extracted
            </h3>
            <div className="bg-muted/50 border rounded-lg p-3 w-full max-w-md text-center mb-4">
              <p className="text-sm text-muted-foreground mb-1">Document URL:</p>
              <code className="text-sm font-mono break-all">
                {url || 'No URL specified'}
              </code>
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm text-muted-foreground">
                The document was processed but no readable content was found
              </p>
              <p className="text-xs text-muted-foreground">
                Try a different document URL or check if the document contains readable text
              </p>
            </div>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 bg-muted/30 backdrop-blur-sm border-t flex justify-between items-center gap-4">
        <div className="flex items-center gap-2">
          {!isStreaming && hasContent && (
            <>
              <Badge variant="outline" className="text-xs">
                <FileText className="h-3 w-3 mr-1" />
                {result.summary.text_sections} sections
              </Badge>
              {result.summary.total_pages > 1 && (
                <Badge variant="outline" className="text-xs">
                  {result.summary.total_pages} pages
                </Badge>
              )}
            </>
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
