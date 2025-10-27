import React, { useState, useMemo } from 'react';
import {
  Presentation,
  FileText,
  Download,
  Eye,
  CheckCircle,
  Paperclip,
  Play,
  AlertTriangle,
  Loader2,
  PresentationIcon,
  ExternalLink,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import {
  getToolTitle,
  extractToolData,
} from '../utils';
import { downloadPresentation, DownloadFormat, handleGoogleSlidesUpload } from '../utils/presentation-utils';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Markdown } from '@/components/ui/markdown';
import { FileAttachment } from '../../file-attachment';
import { PresentationViewer } from './PresentationViewer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface PresentPresentationToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
  assistantContent?: string;
  assistantTimestamp?: string;
  toolTimestamp?: string;
}

export function PresentPresentationToolView({
  name = 'present_presentation',
  toolContent,
  isSuccess = true,
  isStreaming = false,
  onFileClick,
  project,
  assistantContent,
  assistantTimestamp,
  toolTimestamp,
}: PresentPresentationToolViewProps) {
  // Extract data using the standard utility function
  const { toolResult, arguments: args } = useMemo(() => 
    extractToolData(toolContent), [toolContent]
  );

  // Extract the presentation data directly from tool arguments
  const {
    presentationName,
    presentationPath,
    slideCount,
    summary,
    attachments,
    presentationUrl
  } = {
    presentationName: args.presentation_name || args.presentationName || undefined,
    presentationPath: args.presentation_path || args.presentationPath || undefined,
    slideCount: args.slide_count || args.slideCount ? parseInt(args.slide_count || args.slideCount, 10) : undefined,
    summary: args.text || args.summary || undefined,
    attachments: (() => {
      if (args.attachments) {
        if (typeof args.attachments === 'string') {
          return args.attachments.split(',').map((a: string) => a.trim()).filter((a: string) => a.length > 0);
        } else if (Array.isArray(args.attachments)) {
          return args.attachments;
        }
      }
      return undefined;
    })(),
    presentationUrl: args.presentation_url || args.presentationUrl || undefined,
  };

  // Download state
  const [isDownloading, setIsDownloading] = useState(false);

  // Download handlers
  const handleDownload = async (format: DownloadFormat) => {
    if (!project?.sandbox?.sandbox_url || !presentationName) return;

    setIsDownloading(true);
    try {
      if (format === DownloadFormat.GOOGLE_SLIDES) {
        const result = await handleGoogleSlidesUpload(
          project.sandbox.sandbox_url, 
          `/workspace/${presentationPath}`
        );
        // If redirected to auth, don't show error
        if (result?.redirected_to_auth) {
          return; // Don't set loading false, user is being redirected
        }
      } else {
        await downloadPresentation(format,
          project.sandbox.sandbox_url, 
          `/workspace/${presentationPath}`, 
          presentationName
        );
      }
    } catch (error) {
      console.error(`Error downloading ${format}:`, error);
      if (format !== DownloadFormat.GOOGLE_SLIDES) {
        toast.error(`Failed to download ${format}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20">
              <PresentationIcon className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
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
              {isSuccess ? 'Completed' : 'Failed'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              Completing
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <ScrollArea className="h-full w-full">
          <div className="p-4 space-y-4">
            {/* Presentation Info */}
            {(presentationName || slideCount) && (
              <div className="bg-white/50 dark:bg-gray-800/50 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
                <div className="flex items-center space-x-2 mb-3">
                  <FileText className="h-5 w-5 text-gray-600 dark:text-gray-400" />
                  <h3 className="font-semibold text-gray-800 dark:text-gray-200">Presentation Details</h3>
                </div>
                <div className="space-y-2 text-sm">
                  {presentationName && (
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-700 dark:text-gray-300">Name:</span>
                      <span className="text-gray-900 dark:text-gray-100">{presentationName}</span>
                    </div>
                  )}
                  {slideCount && (
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-700 dark:text-gray-300">Slides:</span>
                      <span className="text-gray-900 dark:text-gray-100">{slideCount} slide{slideCount !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      variant="outline" 
                      size="sm"
                      className="border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-950"
                      disabled={isDownloading}
                      title="Download presentation as PDF or PPTX"
                    >
                      {isDownloading ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      Download
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-32">
                    <DropdownMenuItem 
                      onClick={() => handleDownload(DownloadFormat.PDF)}
                      className="cursor-pointer"
                      disabled={isDownloading}
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => handleDownload(DownloadFormat.PPTX)}
                      className="cursor-pointer"
                      disabled={isDownloading}
                    >
                      <Presentation className="h-4 w-4 mr-2" />
                      PPTX
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => handleDownload(DownloadFormat.GOOGLE_SLIDES)}
                      className="cursor-pointer"
                      disabled={isDownloading}
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Google Slides
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {/* Presentation Viewer */}
            {toolContent && !isStreaming && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Play className="h-4 w-4 text-muted-foreground" />
                  <h3 className="font-medium">Presentation Preview</h3>
                </div>
                <div className="rounded-lg border bg-card h-[500px] overflow-hidden">
                  <PresentationViewer
                    assistantContent={assistantContent}
                    toolContent={toolContent}
                    assistantTimestamp={assistantTimestamp}
                    toolTimestamp={toolTimestamp}
                    isSuccess={isSuccess}
                    isStreaming={false}
                    name={name}
                    project={project}
                    showHeader={false}
                  />
                </div>
              </div>
            )}

            {/* Summary Section */}
            {summary && (
              <div className="space-y-2">
                <div className="bg-white/50 dark:bg-gray-800/50 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
                  <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3">
                    {summary}
                  </Markdown>
                </div>
              </div>
            )}

            {/* Attachments Section */}
            {attachments && attachments.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Paperclip className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                  <h3 className="font-semibold text-gray-800 dark:text-gray-200">Presentation Files</h3>
                </div>
                <div className="grid gap-2">
                  {attachments.map((attachment, index) => (
                    <FileAttachment
                      key={index}
                      filepath={attachment}
                      onClick={onFileClick}
                      sandboxId={project?.sandbox_id}
                      project={project}
                      className="bg-white/50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
