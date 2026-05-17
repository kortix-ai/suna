'use client';

import React, { useState, useMemo } from 'react';
import { FileText, Download, CheckCircle2, AlertCircle } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { toast } from '@/lib/toast';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { LoadingState } from '../shared/LoadingState';
import { useAuth } from '@/components/AuthProvider';
import { useDownloadRestriction } from '@/hooks/billing';

export function PdfExportToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const { session } = useAuth();
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'exports',
  });

  const [isDownloading, setIsDownloading] = useState(false);

  // Parse the tool result
  const { outputFile, fileName, message, isSuccess } = useMemo(() => {
    if (toolResult?.output) {
      try {
        const output = toolResult.output;
        const parsed = typeof output === 'string' ? JSON.parse(output) : output;

        const outputFilePath = parsed.output_file || '';
        const extractedFileName = outputFilePath.split('/').pop() || 'document.pdf';

        return {
          outputFile: outputFilePath,
          fileName: extractedFileName,
          message: parsed.message || '',
          isSuccess: toolResult.success !== false && !!parsed.output_file,
        };
      } catch (e) {
        console.error('[PdfExportToolView] Parse error:', e);
        return { outputFile: '', fileName: '', message: '', isSuccess: false };
      }
    }
    return { outputFile: '', fileName: '', message: '', isSuccess: false };
  }, [toolResult]);

  const filePath = toolCall?.arguments?.file_path || '';
  const sourceFileName = filePath.split('/').pop() || 'document';

  if (!toolCall) return null;

  const handleDownload = async () => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }

    if (!outputFile) {
      toast.error('Unable to download - missing file info');
      return;
    }

    setIsDownloading(true);
    try {
      const downloadPath = outputFile.startsWith('/workspace/')
        ? outputFile
        : `/workspace/${outputFile}`;

      const { downloadFile } = await import('@/features/files/api/opencode-files');
      await downloadFile(downloadPath, fileName);

      toast.success(`Downloaded ${fileName}`);
    } catch (error) {
      console.error('Download error:', error);
      toast.error(`Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsDownloading(false);
    }
  };

  // Loading state while streaming
  if (isStreaming) {
    return (
      <Card className="gap-0 flex border-0 shadow-none p-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 border-b p-2 px-4 flex-shrink-0">
          <div className="flex flex-row items-center justify-between">
            <ToolViewIconTitle icon={FileText} title="Export to PDF" />
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1">
          <LoadingState
            icon={FileText}
            iconColor="text-zinc-500"
            bgColor="bg-zinc-50 dark:bg-zinc-900"
            title="Exporting to PDF"
            filePath={sourceFileName}
            progressText="Converting HTML to PDF..."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      {/* Header */}
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 border-b p-2 px-4 flex-shrink-0">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={FileText}
            title={`Export: ${sourceFileName}`}
          />
          {isSuccess && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>Ready</span>
            </div>
          )}
        </div>
      </CardHeader>

      {/* Content */}
      <CardContent className="p-4">
        {isSuccess ? (
          <div className="space-y-3">
            {/* File info */}
            <div className="bg-foreground/[0.02] border border-border/50 rounded-md p-2.5">
              <div className="flex items-center gap-2.5">
                <FileText className="w-3.5 h-3.5 text-muted-foreground/80 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[12.5px] font-medium text-foreground tracking-tight truncate">
                    {fileName}
                  </p>
                  <p className="text-[11.5px] text-muted-foreground/70">
                    PDF Document
                  </p>
                </div>
              </div>
            </div>

            {/* Download button */}
            <Button
              onClick={handleDownload}
              disabled={isDownloading}
              className="w-full h-11 bg-black hover:bg-zinc-800 text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-black font-medium transition-colors"
            >
              {isDownloading ? (
                <>
                  <KortixLoader customSize={16} variant="white" className="mr-2 dark:hidden" />
                  <KortixLoader customSize={16} variant="black" className="mr-2 hidden dark:flex" />
                  <span>Downloading...</span>
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  <span>Download PDF</span>
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3 p-3">
            <AlertCircle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <p className="text-sm text-muted-foreground">
              {message || 'Export failed'}
            </p>
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-zinc-50/80 dark:bg-zinc-900/80 border-t flex justify-end items-center flex-shrink-0 mt-auto">
        <span className="text-xs text-muted-foreground">
          {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
        </span>
      </div>
    </Card>
  );
}
