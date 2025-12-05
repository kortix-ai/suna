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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from '@/components/ui/markdown';
import { FileAttachment } from '../../file-attachment';
import { useAuth } from '@/components/AuthProvider';
import { useDownloadRestriction } from '@/hooks/billing';

interface ExportToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
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
  
  // Download state - track which format is downloading
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);
  const [isDownloadingPPTX, setIsDownloadingPPTX] = useState(false);

  // Determine format from function name or arguments (handle undefined case)
  const name = toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || 'export-presentation';
  let format: ExportFormat = 'pptx';
  
  // Check if it's the new unified export_presentation tool
  if (name === 'export-presentation' || name === 'export_presentation') {
    // Get format from tool call arguments
    format = (toolCall?.arguments?.format as ExportFormat) || 'pptx';
  } else {
    // Legacy: determine from function name
    format = name.includes('pdf') ? 'pdf' : 'pptx';
  }
  
  const config = formatConfigs[format];

  // Extract the export data from tool result (must be before early return)
  const {
    presentationName,
    filePath,
    downloadUrl,
    totalSlides,
    storedLocally,
    message,
    note
  } = useMemo(() => {
    if (toolResult?.output) {
      try {
        const output = toolResult.output;
        const parsed = typeof output === 'string' 
          ? JSON.parse(output) 
          : output;
        return {
          presentationName: parsed.presentation_name || toolCall?.arguments?.presentation_name,
          filePath: parsed.file || parsed[config.fileProperty] || parsed.pptx_file || parsed.pdf_file,
          downloadUrl: parsed.download_url,
          totalSlides: parsed.total_slides,
          storedLocally: parsed.stored_locally,
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
  }, [toolResult, config.fileProperty, toolCall?.arguments]);

  // Defensive check - handle cases where toolCall might be undefined
  if (!toolCall) {
    console.warn('ExportToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const IconComponent = config.icon;

  // Sanitize presentation name the same way the backend does
  // Backend: "".join(c for c in name if c.isalnum() or c in "-_").lower()
  const sanitizePresentationName = (name: string): string => {
    return name
      .split('')
      .filter(c => /[a-zA-Z0-9\-_]/.test(c))
      .join('')
      .toLowerCase();
  };

  // Extract presentation path from file path if available, otherwise construct it
  const getPresentationPath = (): string | null => {
    if (!presentationName) return null;
    
    // Try to extract from file path first (e.g., "presentations/spacex/spacex.pptx" -> "presentations/spacex")
    if (filePath) {
      const match = filePath.match(/^presentations\/([^\/]+)/);
      if (match) {
        return `/workspace/presentations/${match[1]}`;
      }
    }
    
    // Fallback: sanitize the presentation name
    const safeName = sanitizePresentationName(presentationName);
    return `/workspace/presentations/${safeName}`;
  };

  // Download handlers
  const handleDownload = async (downloadFormat: DownloadFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!project?.sandbox?.sandbox_url || !presentationName) return;

    const presentationPath = getPresentationPath();
    if (!presentationPath) {
      toast.error('Unable to determine presentation path');
      return;
    }

    // Set the appropriate downloading state
    if (downloadFormat === DownloadFormat.PDF) {
      setIsDownloadingPDF(true);
    } else if (downloadFormat === DownloadFormat.PPTX) {
      setIsDownloadingPPTX(true);
    }

    try {
      await downloadPresentation(
        downloadFormat,
        project.sandbox.sandbox_url, 
        presentationPath, 
        presentationName
      );
    } catch (error) {
      console.error(`Error downloading ${downloadFormat}:`, error);
      toast.error(`Failed to download ${downloadFormat}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (downloadFormat === DownloadFormat.PDF) {
        setIsDownloadingPDF(false);
      } else if (downloadFormat === DownloadFormat.PPTX) {
        setIsDownloadingPPTX(false);
      }
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

            {/* Action Buttons - Dropdown with PDF and PPTX options */}
            <div className="flex flex-wrap gap-3">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button 
                    variant="outline" 
                    size="sm"
                    className="border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-950"
                    disabled={isDownloadingPDF || isDownloadingPPTX}
                    title="Download presentation"
                  >
                    {(isDownloadingPDF || isDownloadingPPTX) ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    Download
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  <DropdownMenuItem 
                    onClick={() => handleDownload(DownloadFormat.PDF)}
                    className="cursor-pointer"
                    disabled={isDownloadingPDF || isDownloadingPPTX}
                  >
                    {isDownloadingPDF ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <FileText className="h-4 w-4 mr-2" />
                    )}
                    PDF
                  </DropdownMenuItem>
                  <DropdownMenuItem 
                    onClick={() => handleDownload(DownloadFormat.PPTX)}
                    className="cursor-pointer"
                    disabled={isDownloadingPDF || isDownloadingPPTX}
                  >
                    {isDownloadingPPTX ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Presentation className="h-4 w-4 mr-2" />
                    )}
                    PPTX
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
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
  // Create modified toolCall with correct function_name
  const modifiedToolCall = props.toolCall ? {
    ...props.toolCall,
    function_name: 'export_to_pptx'
  } : props.toolCall;
  return <ExportToolView {...props} toolCall={modifiedToolCall} />;
}

export function ExportToPdfToolView(props: ExportToolViewProps) {
  // Create modified toolCall with correct function_name
  const modifiedToolCall = props.toolCall ? {
    ...props.toolCall,
    function_name: 'export_to_pdf'
  } : props.toolCall;
  return <ExportToolView {...props} toolCall={modifiedToolCall} />;
}

