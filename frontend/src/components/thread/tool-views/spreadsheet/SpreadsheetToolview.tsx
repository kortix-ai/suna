import { ToolViewProps } from '../types';
import { getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useState, useMemo } from 'react';
import { getSandboxFileContent } from '@/lib/api/sandbox';
import type { IWorkbookData } from '@univerjs/presets';

const UniverSheet = dynamic(
  () => import('./UniverSheet').then(module => module.UniverSheet),
  { ssr: false }
);

export function SpreadsheetToolView({
  toolCall,
  toolResult,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const [xlsxFile, setXlsxFile] = useState<Blob | null>(null);
  const [workbookData, setWorkbookData] = useState<Partial<IWorkbookData> | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const sandboxId = project?.sandbox?.id;

  // TODO: REMOVE THIS TEST OVERRIDE
  toolResult = {
    output: JSON.stringify({ file_path: '/workspace/uploads/random_data.xlsx' })
  } as any;

  const filePath = useMemo(() => {
    if (toolResult?.output) {
      try {
        const output = typeof toolResult.output === 'string' 
          ? JSON.parse(toolResult.output) 
          : toolResult.output;
        if (output.file_path) return output.file_path;
      } catch (e) {}
    }
    
    if (toolCall?.arguments?.file_path) {
      return toolCall.arguments.file_path;
    }
    
    return null;
  }, [toolCall, toolResult]);

  const filename = useMemo(() => {
    if (!filePath) return undefined;
    const parts = filePath.split('/');
    return parts[parts.length - 1];
  }, [filePath]);

  useEffect(() => {
    if (!sandboxId || !filePath || isStreaming) return;

    const loadFile = async () => {
      setIsLoading(true);
      console.log('[SpreadsheetToolview] Loading file:', { sandboxId, filePath });
      
      try {
        const content = await getSandboxFileContent(sandboxId, filePath);
        console.log('[SpreadsheetToolview] Got content:', {
          type: typeof content,
          isBlob: content instanceof Blob,
          size: content instanceof Blob ? content.size : 'N/A',
          blobType: content instanceof Blob ? content.type : 'N/A'
        });
        
        const isXlsx = filePath.toLowerCase().endsWith('.xlsx');
        
        if (isXlsx) {
          if (content instanceof Blob) {
            console.log('[SpreadsheetToolview] Setting xlsx file blob:', content.size, 'bytes');
            setXlsxFile(content);
          } else {
            console.warn('[SpreadsheetToolview] Expected Blob for .xlsx file, got:', typeof content);
          }
        } else {
          let jsonData: any;
          if (typeof content === 'string') {
            jsonData = JSON.parse(content);
          } else if (content instanceof Blob) {
            const text = await content.text();
            jsonData = JSON.parse(text);
          } else {
            jsonData = content;
          }
          
          console.log('[SpreadsheetToolview] Setting workbook data:', jsonData);
          setWorkbookData(jsonData);
        }
      } catch (error) {
        console.error('[SpreadsheetToolview] Failed to load spreadsheet:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadFile();
  }, [sandboxId, filePath, isStreaming]);

  const name = toolCall?.function_name.replace(/_/g, '-').toLowerCase() || 'spreadsheet';
  const toolTitle = getToolTitle(name);

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border flex-shrink-0 bg-green-100 dark:bg-green-900/50 border-green-300 dark:border-green-700">
              {isStreaming || isLoading ? (
                <Loader2 className="w-5 h-5 text-green-600 dark:text-green-400 animate-spin" />
              ) : (
                <Table className="w-5 h-5 text-green-600 dark:text-green-400" />
              )}
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
              {(isStreaming || isLoading) && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {isLoading ? 'Loading...' : 'Updating...'}
                </p>
              )}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        <UniverSheet 
          xlsxFile={xlsxFile || undefined} 
          workbookData={workbookData || undefined}
          filename={filename}
        />
      </CardContent>
    </Card>
  );
}
