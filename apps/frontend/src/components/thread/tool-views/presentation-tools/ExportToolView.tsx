'use client';

import React, { useState, useMemo } from 'react';
import { Presentation, FileText, Download } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { downloadPresentation, DownloadFormat } from '../utils/presentation-utils';
import { toast } from '@/lib/toast';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { LoadingState } from '../shared/LoadingState';
import { useAuth } from '@/components/AuthProvider';
import { useDownloadRestriction } from '@/hooks/billing';

interface ExportToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

type ExportFormat = 'pptx' | 'pdf';

export function ExportToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
  project,
}: ExportToolViewProps) {
  const { session } = useAuth();
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'exports',
  });
  
  const [downloadingFormat, setDownloadingFormat] = useState<ExportFormat | null>(null);

  const name = toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || 'export-presentation';
  const isUnifiedExport = name === 'export-presentation' || name === 'export_presentation';
  
  const { presentationName, exports, totalSlides } = useMemo(() => {
    console.log('[ExportToolView] Parsing:', { toolResult, name, isUnifiedExport });
    
    if (toolResult?.output) {
      try {
        const output = toolResult.output;
        const parsed = typeof output === 'string' ? JSON.parse(output) : output;
        console.log('[ExportToolView] Parsed output:', parsed);
        
        if (isUnifiedExport && parsed.exports) {
          return {
            presentationName: parsed.presentation_name || toolCall?.arguments?.presentation_name,
            exports: parsed.exports as Record<ExportFormat, { file?: string; download_url?: string; stored_locally?: boolean }>,
            totalSlides: parsed.total_slides,
          };
        }
        
        const format: ExportFormat = name.includes('pdf') ? 'pdf' : 'pptx';
        return {
          presentationName: parsed.presentation_name || toolCall?.arguments?.presentation_name,
          exports: {
            [format]: {
              file: parsed.pptx_file || parsed.pdf_file,
              download_url: parsed.download_url,
              stored_locally: parsed.stored_locally
            }
          } as Record<ExportFormat, { file?: string; download_url?: string; stored_locally?: boolean }>,
          totalSlides: parsed.total_slides,
        };
      } catch (e) {
        console.error('[ExportToolView] Parse error:', e);
        return { presentationName: toolCall?.arguments?.presentation_name };
      }
    }
    return { presentationName: toolCall?.arguments?.presentation_name };
  }, [toolResult, name, isUnifiedExport, toolCall?.arguments]);
  
  const hasPptx = !!exports?.pptx;
  const hasPdf = !!exports?.pdf;
  
  console.log('[ExportToolView] Exports:', { exports, hasPptx, hasPdf });

  if (!toolCall) return null;

  const handleDownload = async (format: ExportFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }

    const exportData = exports?.[format];
    
    // Try direct download first if we have download_url
    if (exportData?.download_url && project?.sandbox?.id) {
      try {
        setDownloadingFormat(format);
        
        const ext = format === 'pdf' ? '.pdf' : '.pptx';
        const rawFilename = exportData.download_url.split('/').pop() || `presentation${ext}`;
        const filename = rawFilename.trim().replace(/[\r\n]+/g, '') || `presentation${ext}`;
        
        const headers: Record<string, string> = {};
        if (session?.access_token) {
          headers['Authorization'] = `Bearer ${session.access_token}`;
        }
        
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${project.sandbox.id}/files/content?path=${encodeURIComponent(exportData.download_url)}`,
          { headers }
        );
        
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        toast.success(`Downloaded ${filename}`);
        return;
      } catch (error) {
        console.error('Direct download failed, trying conversion:', error);
      } finally {
        setDownloadingFormat(null);
      }
    }
    
    // Fallback to conversion endpoint
    if (!project?.sandbox?.sandbox_url || !presentationName) {
      toast.error('Unable to download - missing sandbox or presentation info');
      return;
    }

    setDownloadingFormat(format);
    try {
      const downloadFormat = format === 'pdf' ? DownloadFormat.PDF : DownloadFormat.PPTX;
      await downloadPresentation(
        downloadFormat,
        project.sandbox.sandbox_url, 
        `/workspace/presentations/${presentationName}`, 
        presentationName
      );
      toast.success(`Downloaded ${format.toUpperCase()}`);
    } catch (error) {
      console.error(`Download error:`, error);
      toast.error(`Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDownloadingFormat(null);
    }
  };

  // Loading state
  if (isStreaming) {
    return (
      <Card className="gap-0 flex border-0 shadow-none p-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 border-b p-2 px-4 flex-shrink-0">
          <div className="flex flex-row items-center justify-between">
            <ToolViewIconTitle icon={Download} title="Export Presentation" />
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1">
          <LoadingState
            icon={Download}
            iconColor="text-zinc-500"
            bgColor="bg-zinc-50 dark:bg-zinc-900"
            title="Exporting"
            filePath={presentationName || 'presentation'}
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
            icon={Download} 
            title={presentationName ? `Export: ${presentationName}` : 'Export Presentation'} 
          />
          {totalSlides && (
            <span className="text-xs text-muted-foreground">{totalSlides} slides</span>
          )}
        </div>
      </CardHeader>

      {/* Download Buttons */}
      <CardContent className="p-4 flex-1">
        <div className="flex gap-3">
          {/* PDF Button */}
          <Button
            onClick={() => handleDownload('pdf')}
            disabled={!!downloadingFormat || !hasPdf}
            className="flex-1 h-12 bg-black hover:bg-zinc-800 text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-black font-medium"
          >
            {downloadingFormat === 'pdf' ? (
              <KortixLoader customSize={16} variant="white" className="mr-2 dark:hidden" />
            ) : (
              <FileText className="h-4 w-4 mr-2" />
            )}
            {downloadingFormat === 'pdf' ? (
              <KortixLoader customSize={16} variant="black" className="mr-2 hidden dark:flex" />
            ) : null}
            Download PDF
          </Button>

          {/* PPTX Button */}
          <Button
            onClick={() => handleDownload('pptx')}
            disabled={!!downloadingFormat || !hasPptx}
            className="flex-1 h-12 bg-black hover:bg-zinc-800 text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-black font-medium"
          >
            {downloadingFormat === 'pptx' ? (
              <KortixLoader customSize={16} variant="white" className="mr-2 dark:hidden" />
            ) : (
              <Presentation className="h-4 w-4 mr-2" />
            )}
            {downloadingFormat === 'pptx' ? (
              <KortixLoader customSize={16} variant="black" className="mr-2 hidden dark:flex" />
            ) : null}
            Download PPTX
          </Button>
        </div>

        {/* Show message if no exports available */}
        {!hasPdf && !hasPptx && (
          <p className="text-sm text-muted-foreground text-center mt-3">
            No export files available yet
          </p>
        )}
      </CardContent>

      {/* Footer - pushed to bottom */}
      <div className="px-4 py-2 h-10 bg-zinc-50/80 dark:bg-zinc-900/80 border-t flex justify-end items-center flex-shrink-0 mt-auto">
        <span className="text-xs text-muted-foreground">
          {toolTimestamp ? formatTimestamp(toolTimestamp) : assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
        </span>
      </div>
    </Card>
  );
}
