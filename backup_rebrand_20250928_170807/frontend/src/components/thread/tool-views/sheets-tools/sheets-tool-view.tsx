import React, { useCallback, useMemo, useState } from 'react';
import { ToolViewProps } from '../types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CheckCircle, AlertTriangle, Download, FileSpreadsheet, Table, Grid, Table2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseToolResult } from '../tool-result-parser';
import { FileAttachment } from '../../file-attachment';
import { XlsxRenderer } from '@/components/file-renderers/xlsx-renderer';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/components/AuthProvider';
import { fetchFileContent } from '@/hooks/react-query/files/use-file-queries';

function getFileUrl(sandboxId: string | undefined, path: string): string {
  if (!sandboxId) return path;
  if (!path.startsWith('/workspace')) {
    path = `/workspace/${path.startsWith('/') ? path.substring(1) : path}`;
  }
  try {
    path = path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => String.fromCharCode(parseInt(hexCode, 16)));
  } catch {}
  const url = new URL(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content`);
  url.searchParams.append('path', path);
  return url.toString();
}

function toObject(val: any): any | null {
  if (!val) return null;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return null;
}

const isXlsxPath = (p?: string | null) => !!p && p.toLowerCase().endsWith('.xlsx');
const isCsvPath = (p?: string | null) => !!p && p.toLowerCase().endsWith('.csv');

export function SheetsToolView({
  name = 'sheets-tool',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const { session } = useAuth();
  const parsed = useMemo(() => parseToolResult(toolContent) || parseToolResult(assistantContent), [toolContent, assistantContent]);
  const toolName = (parsed?.toolName || name).toLowerCase();
  const outputObj = useMemo(() => toObject(parsed?.toolOutput), [parsed]);

  const createdPath: string | null = outputObj?.created || null;
  const updatedPath: string | null = outputObj?.updated || null;
  const chartSaved: string | null = outputObj?.chart_saved || null;
  const exportedCsv: string | null = outputObj?.exported_csv || null;
  const viewFilePath: string | null = outputObj?.file_path || null;
  const formattedPath: string | null = outputObj?.formatted || null;

  const primaryXlsx: string | null = (
    (formattedPath && isXlsxPath(formattedPath) ? formattedPath : null) ||
    (chartSaved && isXlsxPath(chartSaved) ? chartSaved : null) ||
    (createdPath && isXlsxPath(createdPath) ? createdPath : null) ||
    (updatedPath && isXlsxPath(updatedPath) ? updatedPath : null) ||
    (viewFilePath && isXlsxPath(viewFilePath) ? viewFilePath : null)
  );

  const primaryCsv: string | null = (
    exportedCsv ||
    (createdPath && isCsvPath(createdPath) ? createdPath : null) ||
    (updatedPath && isCsvPath(updatedPath) ? updatedPath : null) ||
    (viewFilePath && isCsvPath(viewFilePath) ? viewFilePath : null) ||
    (primaryXlsx ? primaryXlsx.replace(/\.xlsx$/i, '.csv') : null)
  );



  const sheetTitle = useMemo(() => {
    switch (toolName) {
      case 'create-sheet': return 'Create Sheet';
      case 'update-sheet': return 'Update Sheet';
      case 'view-sheet': return 'View Sheet';
      case 'analyze-sheet': return 'Analyze Sheet';
      case 'visualize-sheet': return 'Visualize Sheet';
      case 'format-sheet': return 'Format Sheet';
      default: return 'Sheets';
    }
  }, [toolName]);

  const sheetIconBgColor = useMemo(() => {
    switch (toolName) {
      case 'create-sheet': return 'bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20';
      case 'update-sheet': return 'bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20';
      case 'view-sheet': return 'bg-gradient-to-br from-yellow-500/20 to-yellow-600/10 border border-yellow-500/20';
      case 'analyze-sheet': return 'bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20';
      case 'visualize-sheet': return 'bg-gradient-to-br from-green-500/20 to-green-600/10 border border-green-500/20';
      case 'format-sheet': return 'bg-gradient-to-br from-red-500/20 to-red-600/10 border border-red-500/20';
    }
  }, [toolContent]);

  const getSheetIconColor = useCallback(() => {
    switch (toolName) {
      case 'create-sheet': return 'text-emerald-600';
      case 'update-sheet': return 'text-blue-600';
      case 'view-sheet': return 'text-yellow-600';
      case 'analyze-sheet': return 'text-purple-600';
      case 'visualize-sheet': return 'text-green-600';
      case 'format-sheet': return 'text-red-600';
    }
  }, [toolName]);

  const sandboxId = project?.sandbox?.id;

  const handleDownload = useCallback(async (filePath: string | null, fallbackName: string) => {
    try {
      if (!filePath) return;
      if (!sandboxId || !session?.access_token) {
        const url = getFileUrl(sandboxId, filePath);
        window.open(url, '_blank');
        return;
      }
      const blob = (await fetchFileContent(sandboxId, filePath, 'blob', session.access_token)) as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const nameFromPath = filePath.split('/').pop() || fallbackName;
      a.download = nameFromPath;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Download failed:', e);
    }
  }, [sandboxId, session?.access_token]);

  const inlineHeaders: string[] | null = (
    outputObj?.result_preview?.headers ||
    outputObj?.headers ||
    outputObj?.columns ||
    null
  );
  const inlineRows: any[][] | null = (
    outputObj?.result_preview?.rows ||
    outputObj?.rows ||
    outputObj?.sample_rows ||
    outputObj?.data ||
    null
  );

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn("relative p-2 rounded-lg", sheetIconBgColor)}>
              <Table2 className={cn("w-5 h-5", getSheetIconColor())} />
            </div>
            <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
              {sheetTitle}
            </CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <Download className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem disabled={!primaryXlsx} onClick={() => handleDownload(primaryXlsx, 'sheet.xlsx')}>
                  <FileSpreadsheet className="h-4 w-4" /> Download XLSX
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!primaryCsv} onClick={() => handleDownload(primaryCsv, 'sheet.csv')}>
                  <Download className="h-4 w-4" /> Download CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {!isStreaming && (
              <Badge
                variant="secondary"
                className={cn(
                  isSuccess
                    ? 'bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300'
                    : 'bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300'
                )}
              >
                {isSuccess ? <CheckCircle className="h-3.5 w-3.5 mr-1" /> : <AlertTriangle className="h-3.5 w-3.5 mr-1" />}
                {isSuccess ? 'Success' : 'Failed'}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden">
        <div className="flex flex-col h-full">
          <div className="flex-1 min-w-0">
            <ScrollArea className="h-full">
              <div className="p-4 flex flex-col h-full space-y-4">
                {primaryXlsx ? (
                  <div className="space-y-3 h-full">
                    <XlsxRenderer
                      filePath={primaryXlsx}
                      fileName={(primaryXlsx.split('/').pop() || 'sheet.xlsx')}
                      project={project}
                      className="w-full h-[60vh]"
                    />
                  </div>
                ) : primaryCsv ? (
                  <div className="space-y-3 h-full">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Table className="h-4 w-4" />
                      Preview (CSV data)
                    </div>
                    <FileAttachment
                      filepath={primaryCsv}
                      sandboxId={project?.sandbox?.id}
                      showPreview={true}
                      collapsed={false}
                      project={project}
                      customStyle={{ gridColumn: '1 / -1' }}
                      className="w-full h-[60vh]"
                    />
                  </div>
                ) : inlineHeaders || inlineRows ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Table className="h-4 w-4" />
                      Result preview
                    </div>
                    <div className="border rounded-lg overflow-auto">
                      <table className="w-full text-sm">
                        {inlineHeaders && (
                          <thead className="bg-muted/50">
                            <tr>
                              {inlineHeaders.map((h: string, idx: number) => (
                                <th key={idx} className="px-3 py-2 text-left font-medium text-foreground">{h}</th>
                              ))}
                            </tr>
                          </thead>
                        )}
                        {inlineRows && (
                          <tbody>
                            {inlineRows.map((r: any[], rIdx: number) => (
                              <tr key={rIdx} className="border-t">
                                {r.map((c: any, cIdx: number) => (
                                  <td key={cIdx} className="px-3 py-2 text-foreground/90">{String(c ?? '')}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        )}
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No preview available yet.</div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </CardContent>
    </Card>
  );
} 