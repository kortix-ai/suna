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
  extractToolData,
} from '../utils';
import { downloadPresentation, DownloadFormat } from '../utils/presentation-utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from '@/components/ui/markdown';
import { FileAttachment } from '../../file-attachment';
import { useAuth } from '@/components/AuthProvider';

interface ExportToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
  assistantContent?: string;
  assistantTimestamp?: string;
  toolTimestamp?: string;
}

type ExportFormat = 'pptx' | 'pdf';

interface FormatConfig {
  icon: LucideIcon;
  iconColor: string;
  badgeColor: string;
  noteBgColor: string;
  noteBorderColor: string;
  noteTextColor: string;
  defaultExtension: string;
  fileProperty: string;
  downloadFormat: DownloadFormat;
}

// Shared color scheme for all export formats
const exportColors = {
  iconColor: 'text-blue-500 dark:text-blue-400',
  badgeColor: 'bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300',
  noteBgColor: 'bg-blue-50 dark:bg-blue-900/20',
  noteBorderColor: 'border-blue-200 dark:border-blue-800',
  noteTextColor: 'text-blue-800 dark:text-blue-200',
};

const formatConfigs: Record<ExportFormat, FormatConfig> = {
  pptx: {
    icon: Presentation,
    iconColor: exportColors.iconColor,
    badgeColor: exportColors.badgeColor,
    noteBgColor: exportColors.noteBgColor,
    noteBorderColor: exportColors.noteBorderColor,
    noteTextColor: exportColors.noteTextColor,
    defaultExtension: '.pptx',
    fileProperty: 'pptx_file',
    downloadFormat: DownloadFormat.PPTX,
  },
  pdf: {
    icon: FileText,
    iconColor: exportColors.iconColor,
    badgeColor: exportColors.badgeColor,
    noteBgColor: exportColors.noteBgColor,
    noteBorderColor: exportColors.noteBorderColor,
    noteTextColor: exportColors.noteTextColor,
    defaultExtension: '.pdf',
    fileProperty: 'pdf_file',
    downloadFormat: DownloadFormat.PDF,
  },
};

export function ExportToolView({
  name = 'export_to_pptx',
  toolContent,
  isSuccess = true,
  isStreaming = false,
  onFileClick,
  project,
  assistantContent,
  assistantTimestamp,
  toolTimestamp,
}: ExportToolViewProps) {
  // Auth for file downloads
  const { session } = useAuth();
  
  // Determine format from tool name
  const format: ExportFormat = name.includes('pdf') ? 'pdf' : 'pptx';
  const config = formatConfigs[format];
  const IconComponent = config.icon;

  // Extract data using the standard utility function
  const { toolResult, arguments: args } = useMemo(() => 
    extractToolData(toolContent), [toolContent]
  );

  // Extract the export data from tool result
  const {
    presentationName,
    filePath,
    downloadUrl,
    totalSlides,
    storedLocally,
    message,
    note
  } = useMemo(() => {
    if (toolResult?.toolOutput) {
      try {
        const parsed = typeof toolResult.toolOutput === 'string' 
          ? JSON.parse(toolResult.toolOutput) 
          : toolResult.toolOutput;
        return {
          presentationName: parsed.presentation_name,
          filePath: parsed[config.fileProperty] || parsed.pptx_file || parsed.pdf_file,
          downloadUrl: parsed.download_url,
          totalSlides: parsed.total_slides,
          storedLocally: parsed.stored_locally,
          message: parsed.message,
          note: parsed.note
        };
      } catch (e) {
        console.error('Error parsing tool result:', e);
        return {};
      }
    }
    return {};
  }, [toolResult, config.fileProperty]);

  // Download state
  const [isDownloading, setIsDownloading] = useState(false);

  // Download handlers
  const handleDownload = async (downloadFormat: DownloadFormat) => {
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
  const handleDirectDownload = async () => {
    if (!downloadUrl || !project?.sandbox?.id) return;
    
    try {
      setIsDownloading(true);
      
      // Extract filename from downloadUrl
      const filename = downloadUrl.split('/').pop() || `presentation${config.defaultExtension}`;
      
      // Use backend file endpoint which handles sandbox startup automatically
      const headers: Record<string, string> = {};
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }
      
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${project.sandbox.id}/files/content?path=${encodeURIComponent(downloadUrl)}`,
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
      toast.error(`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl border bg-gradient-to-br from-blue-500/20 to-blue-600/10 border-blue-500/20">
              <IconComponent className={`w-5 h-5 ${config.iconColor}`} />
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
                  ? config.badgeColor
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {isSuccess ? 'Completed' : 'Failed'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className={config.badgeColor}>
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
              <div className="bg-white/50 dark:bg-gray-800/50 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
                <div className="flex items-center space-x-2 mb-3">
                  <FileText className="h-5 w-5 text-gray-600 dark:text-gray-400" />
                  <h3 className="font-semibold text-gray-800 dark:text-gray-200">Export Details</h3>
                </div>
                <div className="space-y-2 text-sm">
                  {presentationName && (
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-700 dark:text-gray-300">Presentation:</span>
                      <span className="text-gray-900 dark:text-gray-100">{presentationName}</span>
                    </div>
                  )}
                  {totalSlides && (
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-700 dark:text-gray-300">Slides:</span>
                      <span className="text-gray-900 dark:text-gray-100">{totalSlides} slide{totalSlides !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                  {storedLocally !== undefined && (
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-700 dark:text-gray-300">Storage:</span>
                      <span className="text-gray-900 dark:text-gray-100">
                        {storedLocally ? 'Stored locally for repeated downloads' : 'Direct download only'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-3">
              {storedLocally && downloadUrl ? (
                // Direct download button for stored files
                <Button 
                  variant="outline" 
                  size="sm"
                  className="border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-950"
                  onClick={handleDirectDownload}
                  disabled={isDownloading}
                  title={`Download stored ${format.toUpperCase()} file`}
                >
                  {isDownloading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  Download {format.toUpperCase()}
                </Button>
              ) : (
                // Direct download button for conversion
                <Button 
                  variant="outline" 
                  size="sm"
                  className="border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-950"
                  onClick={() => handleDownload(config.downloadFormat)}
                  disabled={isDownloading}
                  title={`Download presentation as ${format.toUpperCase()}`}
                >
                  {isDownloading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  Download {format.toUpperCase()}
                </Button>
              )}
            </div>

            {/* Message */}
            {message && (
              <div className="space-y-2">
                <div className="bg-white/50 dark:bg-gray-800/50 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
                  <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3">
                    {message}
                  </Markdown>
                </div>
              </div>
            )}


            {/* File Attachment for stored files */}
            {filePath && storedLocally && (
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <IconComponent className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                  <h3 className="font-semibold text-gray-800 dark:text-gray-200">Exported File</h3>
                </div>
                <div className="grid gap-2">
                  <FileAttachment
                    filepath={filePath}
                    onClick={onFileClick}
                    sandboxId={project?.sandbox_id}
                    project={project}
                    className="bg-white/50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700"
                  />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// Export convenience wrappers
export function ExportToPptxToolView(props: ExportToolViewProps) {
  return <ExportToolView {...props} name="export_to_pptx" />;
}

export function ExportToPdfToolView(props: ExportToolViewProps) {
  return <ExportToolView {...props} name="export_to_pdf" />;
}

