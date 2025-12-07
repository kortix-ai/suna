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
  formatTimestamp,
} from '../utils';
import { downloadPresentation, DownloadFormat } from '../utils/presentation-utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/components/AuthProvider';
import { useDownloadRestriction } from '@/hooks/billing';
import { cn } from '@/lib/utils';

interface ExportToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

type ExportFormat = 'pptx' | 'pdf';

interface FormatConfig {
  icon: LucideIcon;
  label: string;
  description: string;
  defaultExtension: string;
  fileProperty: string;
  downloadFormat: DownloadFormat;
  gradient: string;
  iconColor: string;
}

const formatConfigs: Record<ExportFormat, FormatConfig> = {
  pdf: {
    icon: FileText,
    label: 'PDF',
    description: 'Best for sharing & printing',
    defaultExtension: '.pdf',
    fileProperty: 'pdf_file',
    downloadFormat: DownloadFormat.PDF,
    gradient: 'from-red-500 to-red-600',
    iconColor: 'text-white',
  },
  pptx: {
    icon: Presentation,
    label: 'PowerPoint',
    description: 'Editable presentation',
    defaultExtension: '.pptx',
    fileProperty: 'pptx_file',
    downloadFormat: DownloadFormat.PPTX,
    gradient: 'from-orange-500 to-orange-600',
    iconColor: 'text-white',
  },
};

export function ExportToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
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
  
  const {
    presentationName,
    exports,
    totalSlides,
    partialSuccess
  } = useMemo(() => {
    if (toolResult?.output) {
      try {
        const output = toolResult.output;
        const parsed = typeof output === 'string' ? JSON.parse(output) : output;
        
        if (isUnifiedExport && parsed.exports) {
          return {
            presentationName: parsed.presentation_name || toolCall?.arguments?.presentation_name,
            exports: parsed.exports,
            totalSlides: parsed.total_slides,
            partialSuccess: parsed.partial_success
          };
        }
        
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
        };
      } catch (e) {
        console.error('Error parsing tool result:', e);
        return { presentationName: toolCall?.arguments?.presentation_name };
      }
    }
    return { presentationName: toolCall?.arguments?.presentation_name };
  }, [toolResult, name, isUnifiedExport, toolCall?.arguments]);
  
  const availableExports = exports ? Object.keys(exports) as ExportFormat[] : [];
  const hasPptx = availableExports.includes('pptx');
  const hasPdf = availableExports.includes('pdf');

  if (!toolCall) {
    console.warn('ExportToolView: toolCall is undefined.');
    return null;
  }

  const handleDownload = async (downloadFormat: DownloadFormat, format: ExportFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    if (!project?.sandbox?.sandbox_url || !presentationName) return;

    setDownloadingFormat(format);
    try {
      await downloadPresentation(
        downloadFormat,
        project.sandbox.sandbox_url, 
        `/workspace/presentations/${presentationName}`, 
        presentationName
      );
      toast.success(`Downloaded ${format.toUpperCase()} successfully`);
    } catch (error) {
      console.error(`Error downloading ${downloadFormat}:`, error);
      toast.error(`Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDownloadingFormat(null);
    }
  };

  const handleDirectDownload = async (format: ExportFormat) => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    
    const exportData = exports?.[format];
    if (!exportData?.download_url || !project?.sandbox?.id) return;
    
    try {
      setDownloadingFormat(format);
      
      const config = formatConfigs[format];
      const filename = exportData.download_url.split('/').pop() || `presentation${config.defaultExtension}`;
      
      const headers: Record<string, string> = {};
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }
      
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${project.sandbox.id}/files/content?path=${encodeURIComponent(exportData.download_url)}`,
        { headers }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
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
      
      toast.success(`Downloaded ${filename}`);
    } catch (error) {
      console.error('Error downloading file:', error);
      toast.error(`Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDownloadingFormat(null);
    }
  };

  const renderDownloadButton = (format: ExportFormat) => {
    const config = formatConfigs[format];
    const Icon = config.icon;
    const exportData = exports?.[format];
    const isLoading = downloadingFormat === format;
    
    return (
      <Button
        key={format}
        onClick={() => exportData?.download_url ? handleDirectDownload(format) : handleDownload(config.downloadFormat, format)}
        disabled={!!downloadingFormat || !exportData}
        className={cn(
          "h-auto py-4 px-5 flex items-center gap-4 justify-start w-full",
          "bg-gradient-to-r hover:opacity-90 transition-opacity",
          config.gradient,
          "text-white border-0 shadow-md"
        )}
      >
        <div className="w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center flex-shrink-0">
          {isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-white" />
          ) : (
            <Icon className="h-5 w-5 text-white" />
          )}
        </div>
        <div className="flex-1 text-left">
          <div className="font-semibold text-base">
            {isLoading ? 'Downloading...' : `Download ${config.label}`}
          </div>
          <div className="text-xs text-white/80 font-normal">
            {config.description}
          </div>
        </div>
        <Download className="h-5 w-5 text-white/80 flex-shrink-0" />
      </Button>
    );
  };

  // Streaming state
  if (isStreaming) {
    return (
      <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col overflow-hidden bg-card">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4">
          <div className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative p-2 rounded-lg bg-gradient-to-br from-zinc-500/20 to-zinc-600/10 border border-zinc-500/20">
                <Presentation className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
              </div>
              <CardTitle className="text-base font-medium">
                {getToolTitle(name)}
              </CardTitle>
            </div>
            <Badge className="h-6 bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300 border-0">
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
              Exporting
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-8">
          <div className="flex flex-col items-center justify-center py-8">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-gradient-to-b from-blue-100 to-blue-50 dark:from-blue-800/40 dark:to-blue-900/60">
              <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
            </div>
            <h3 className="text-lg font-semibold mb-1">Exporting Presentation</h3>
            <p className="text-sm text-muted-foreground">
              {presentationName || 'Processing...'}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20">
              <CheckCircle className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium">
                {getToolTitle(name)}
              </CardTitle>
            </div>
          </div>
          <Badge
            className={cn(
              "h-6 border-0",
              isSuccess
                ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
            )}
          >
            {isSuccess ? (
              <CheckCircle className="h-3 w-3 mr-1" />
            ) : (
              <AlertTriangle className="h-3 w-3 mr-1" />
            )}
            {partialSuccess ? 'Partial' : (isSuccess ? 'Ready' : 'Failed')}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="p-6">
        {/* Presentation info */}
        <div className="flex items-center gap-3 mb-6 pb-4 border-b border-border/50">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500/10 to-purple-500/10 border border-blue-500/20 flex items-center justify-center">
            <Presentation className="h-6 w-6 text-blue-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground truncate">
              {presentationName || 'Presentation'}
            </h3>
            <p className="text-sm text-muted-foreground">
              {totalSlides ? `${totalSlides} slide${totalSlides !== 1 ? 's' : ''}` : 'Export complete'}
            </p>
          </div>
        </div>

        {/* Download buttons */}
        <div className="space-y-3">
          {hasPdf && renderDownloadButton('pdf')}
          {hasPptx && renderDownloadButton('pptx')}
          
          {!hasPdf && !hasPptx && (
            <div className="text-center py-8 text-muted-foreground">
              <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-amber-500" />
              <p>No exports available</p>
            </div>
          )}
        </div>
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 border-t border-zinc-200 dark:border-zinc-800 flex justify-end items-center">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {toolTimestamp && !isStreaming
            ? formatTimestamp(toolTimestamp)
            : assistantTimestamp
              ? formatTimestamp(assistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}
