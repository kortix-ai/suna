import React, { useState, useMemo } from 'react';
import {
  Presentation,
  FileText,
  Download,
  CheckCircle,
  AlertTriangle,
  Loader2,
  LucideIcon,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import {
  getToolTitle,
} from '../utils';
import { downloadPresentation, DownloadFormat } from '../utils/presentation-utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { UnifiedMarkdown } from '@/components/markdown';
import { FileAttachment } from '../../file-attachment';
import { useAuth } from '@/components/AuthProvider';
import { useDownloadRestriction } from '@/hooks/billing';

interface ExportToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

type ExportFormat = 'pptx' | 'pdf';

interface FormatConfig {
  icon: LucideIcon;
  defaultExtension: string;
  fileProperty: string;
  downloadFormat: DownloadFormat;
}

const formatConfigs: Record<ExportFormat, FormatConfig> = {
  pptx: {
    icon: Presentation,
    defaultExtension: '.pptx',
    fileProperty: 'pptx_file',
    downloadFormat: DownloadFormat.PPTX,
  },
  pdf: {
    icon: FileText,
    defaultExtension: '.pdf',
    fileProperty: 'pdf_file',
    downloadFormat: DownloadFormat.PDF,
  },
};

export function ExportToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  onFileClick,
  project,
}: ExportToolViewProps) {
  // All hooks must be called unconditionally at the top
  // Auth for file downloads
  const { session } = useAuth();
  
  // Download restriction for free tier users
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'exports',
  });
  
  // Download state
  const [isDownloading, setIsDownloading] = useState(false);

  // Determine format from function name (handle undefined case)
  const name = toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || 'export-presentation';
  const isUnifiedExport = name === 'export-presentation' || name === 'export_presentation';
  
  // Extract the export data from tool result (must be before early return)
  const {
    presentationName,
    exports,
    totalSlides,
    message,
    note,
    partialSuccess
  } = useMemo(() => {
    if (toolResult?.output) {
      try {
        const output = toolResult.output;
        const parsed = typeof output === 'string' 
          ? JSON.parse(output) 
          : output;
        
        // Handle unified export format
        if (isUnifiedExport && parsed.exports) {
          return {
            presentationName: parsed.presentation_name || toolCall?.arguments?.presentation_name,
            exports: parsed.exports, // { pptx: {...}, pdf: {...} }
            totalSlides: parsed.total_slides,
            message: parsed.message,
            note: parsed.note,
            partialSuccess: parsed.partial_success
          };
        }
        
        // Handle legacy single-format exports (backward compatibility)
        const format: ExportFormat = name.includes('pdf') ? 'pdf' : 'pptx';
        const config = formatConfigs[format];
        return {
          presentationName: parsed.presentation_name || toolCall?.arguments?.presentation_name,
          exports: {
            [format]: {
              file: parsed[config.fileProperty] || parsed.pptx_file || parsed.pdf_file,
              download_url: parsed.download_url,
              stored_locally: parsed.stored_locally
            }
          },
          totalSlides: parsed.total_slides,
          message: parsed.message,
          note: parsed.note
        };
      } catch (e) {
        console.error('Error parsing tool result:', e);
        // Fallback: try to extract from arguments
        return {
          presentationName: toolCall?.arguments?.presentation_name,
        };
      }
    }
    // Fallback: extract from arguments
    return {
      presentationName: toolCall?.arguments?.presentation_name,
    };
  }, [toolResult, name, isUnifiedExport, toolCall?.arguments]);

  // Defensive check - handle cases where toolCall might be undefined
  if (!toolCall) {
    console.warn('ExportToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  // Determine available exports
  const availableExports = exports ? Object.keys(exports) as ExportFormat[] : [];
  const hasPptx = availableExports.includes('pptx');
  const hasPdf = availableExports.includes('pdf');

  // Download handlers
  const handleDownload = async (downloadFormat: DownloadFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!project?.sandbox?.sandbox_url || !presentationName) return;

    setIsDownloading(true);
    try {
      await downloadPresentation(
        downloadFormat,
        project.sandbox.sandbox_url, 
        `/workspace/presentations/${presentationName}`, 
        presentationName
      );
    } catch (error) {
      console.error(`Error downloading ${downloadFormat}:`, error);
      toast.error(`Failed to download ${downloadFormat}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsDownloading(false);
    }
  };

  // Handle direct file download for stored files
  // Uses backend API which auto-starts sandbox if needed
  const handleDirectDownload = async (format: ExportFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    
    const exportData = exports?.[format];
    if (!exportData?.download_url || !project?.sandbox?.id) return;
    
    try {
      setIsDownloading(true);
      
      const config = formatConfigs[format];
      // Extract filename from downloadUrl
      const filename = exportData.download_url.split('/').pop() || `presentation${config.defaultExtension}`;
      
      // Use backend file endpoint which handles sandbox startup automatically
      const headers: Record<string, string> = {};
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }
      
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${project.sandbox.id}/files/content?path=${encodeURIComponent(exportData.download_url)}`,
        { headers }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      
      toast.success(`Downloaded ${filename}`, {
        duration: 3000,
      });
    } catch (error) {
      console.error('Error downloading file:', error);
      toast.error(`Failed to download ${format.toUpperCase()}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <Presentation className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {getToolTitle(name)}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="secondary"
              className={
                isSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {partialSuccess ? 'Partial' : (isSuccess ? 'Success' : 'Failed')}
            </Badge>
          )}

          {isStreaming && (
            <Badge
              variant="secondary"
              className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              Exporting
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <ScrollArea className="h-full w-full">
          <div className="p-4 space-y-4">
            {/* Export Info */}
            {(presentationName || totalSlides) && (
              <div className="bg-card rounded-lg p-4 border border-border">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  {presentationName && (
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      <span className="font-medium text-foreground">{presentationName}</span>
                    </div>
                  )}
                  {totalSlides && (
                    <div className="flex items-center gap-2">
                      <Presentation className="h-4 w-4" />
                      <span>{totalSlides} slide{totalSlides !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* File Cards - Clean Kortix Style */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {hasPptx && exports?.pptx && (
                <div className="bg-card rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Presentation className="h-5 w-5 text-muted-foreground" />
                      <span className="font-medium text-foreground">PPTX</span>
                    </div>
                    <Badge variant="secondary">PowerPoint</Badge>
                  </div>
                  
                  {exports.pptx.file && (
                    <div className="mb-3">
                      <FileAttachment
                        filepath={exports.pptx.file}
                        onClick={onFileClick}
                        sandboxId={project?.sandbox_id}
                        project={project}
                        className="bg-muted/50 border-border"
                      />
                    </div>
                  )}

                  <Button 
                    variant="default"
                    className="w-full"
                    onClick={() => exports.pptx.download_url ? handleDirectDownload('pptx') : handleDownload(DownloadFormat.PPTX)}
                    disabled={isDownloading}
                  >
                    {isDownloading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Downloading...
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4 mr-2" />
                        Download PPTX
                      </>
                    )}
                  </Button>
                </div>
              )}
              
              {hasPdf && exports?.pdf && (
                <div className="bg-card rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                      <span className="font-medium text-foreground">PDF</span>
                    </div>
                    <Badge variant="secondary">Document</Badge>
                  </div>
                  
                  {exports.pdf.file && (
                    <div className="mb-3">
                      <FileAttachment
                        filepath={exports.pdf.file}
                        onClick={onFileClick}
                        sandboxId={project?.sandbox_id}
                        project={project}
                        className="bg-muted/50 border-border"
                      />
                    </div>
                  )}

                  <Button 
                    variant="default"
                    className="w-full"
                    onClick={() => exports.pdf.download_url ? handleDirectDownload('pdf') : handleDownload(DownloadFormat.PDF)}
                    disabled={isDownloading}
                  >
                    {isDownloading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Downloading...
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4 mr-2" />
                        Download PDF
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>

            {/* Message */}
            {message && (
              <div className="bg-muted/50 rounded-lg p-4 border border-border">
                <UnifiedMarkdown 
                  content={message} 
                  className="text-sm" 
                />
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}


