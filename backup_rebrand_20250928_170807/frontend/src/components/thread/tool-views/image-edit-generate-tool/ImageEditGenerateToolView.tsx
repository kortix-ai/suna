import React from 'react';
import {
  Palette,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Wand2,
  Edit3,
  ImageIcon,
  Sparkles,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import {
  formatTimestamp,
  getToolTitle,
} from '../utils';
import { extractImageEditGenerateData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileAttachment } from '../../file-attachment';

interface ImageEditGenerateToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

export function ImageEditGenerateToolView({
  name = 'image_edit_or_generate',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  onFileClick,
  project,
}: ImageEditGenerateToolViewProps) {

  const {
    mode,
    prompt,
    imagePath,
    generatedImagePath,
    status,
    error,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractImageEditGenerateData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name) || 'Image Generation';

  const handleFileClick = (filePath: string) => {
    if (onFileClick) {
      onFileClick(filePath);
    }
  };

  const getModeIcon = () => {
    if (mode === 'generate') {
      return <Sparkles className="w-5 h-5 text-purple-500 dark:text-purple-400" />;
    } else if (mode === 'edit') {
      return <Edit3 className="w-5 h-5 text-purple-500 dark:text-purple-400" />;
    }
    return <Palette className="w-5 h-5 text-purple-500 dark:text-purple-400" />;
  };

  const getModeText = () => {
    if (mode === 'generate') return 'Image Generation';
    if (mode === 'edit') return 'Image Editing';
    return 'Image Tool';
  };

  const getDisplayPrompt = () => {
    if (!prompt) return 'No prompt provided';
    return prompt.length > 100 ? `${prompt.substring(0, 100)}...` : prompt;
  };

  // Collect all images to display
  const imagesToDisplay: string[] = [];
  if (imagePath) imagesToDisplay.push(imagePath);
  if (generatedImagePath) imagesToDisplay.push(generatedImagePath);

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20">
              {getModeIcon()}
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {getModeText()}
              </CardTitle>
              {prompt && (
                <p className="text-xs text-muted-foreground mt-0.5 max-w-md truncate">
                  {getDisplayPrompt()}
                </p>
              )}
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="secondary"
              className={
                actualIsSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {actualIsSuccess ? 'Success' : 'Failed'}
            </Badge>
          )}

          {isStreaming && (
            <Badge className="bg-gradient-to-b from-purple-200 to-purple-100 text-purple-700 dark:from-purple-800/50 dark:to-purple-900/60 dark:text-purple-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              {mode === 'generate' ? 'Generating' : 'Editing'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <ScrollArea className="h-full w-full">
          <div className="p-4 space-y-6">
            {/* Error Message */}
            {error && (
              <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="font-medium">Error</span>
                </div>
                <p className="text-sm text-red-600 dark:text-red-300 mt-1">{error}</p>
              </div>
            )}

            {/* Generated Images */}
            {imagesToDisplay.length > 0 ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <ImageIcon className="h-4 w-4" />
                  {mode === 'generate' ? 'Generated Image' : 'Images'} ({imagesToDisplay.length})
                </div>

                <div className={cn(
                  "grid gap-3",
                  imagesToDisplay.length === 1 ? "grid-cols-1" :
                    imagesToDisplay.length > 4 ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-3" :
                      "grid-cols-1 sm:grid-cols-2"
                )}>
                  {imagesToDisplay.map((imagePath, index) => {
                    const isInputImage = imagePath === imagePath && mode === 'edit' && index === 0;
                    const isGeneratedImage = imagePath === generatedImagePath;
                    
                    return (
                      <div
                        key={index}
                        className="relative group"
                      >
                        {/* Image Label */}
                        {imagesToDisplay.length > 1 && (
                          <div className="absolute top-2 left-2 z-10">
                            <Badge 
                              variant="secondary" 
                              className="text-xs bg-black/70 text-white border-0"
                            >
                              {isInputImage ? 'Input' : isGeneratedImage ? 'Generated' : `Image ${index + 1}`}
                            </Badge>
                          </div>
                        )}
                        
                        <FileAttachment
                          filepath={imagePath}
                          onClick={handleFileClick}
                          sandboxId={project?.sandbox?.id}
                          showPreview={true}
                          className="aspect-square w-full"
                          customStyle={{
                            width: '100%',
                            height: '100%',
                            '--attachment-height': '100%'
                          } as React.CSSProperties}
                          collapsed={false}
                          project={project}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                  {mode === 'generate' ? (
                    <Sparkles className="h-8 w-8 text-muted-foreground" />
                  ) : (
                    <Edit3 className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>
                <h3 className="text-lg font-medium text-foreground mb-2">
                  {mode === 'generate' ? 'Image Generation' : 'Image Editing'}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {actualIsSuccess ? 'Processing completed' : 'No image generated'}
                </p>
              </div>
            )}

            {/* Prompt Details */}
            {prompt && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Wand2 className="h-4 w-4" />
                  Prompt
                </div>
                <div className="p-3 rounded-lg bg-muted/50 border">
                  <p className="text-sm text-foreground break-words">{prompt}</p>
                </div>
              </div>
            )}

            {/* Status Message */}
            {status && status !== prompt && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  Status
                </div>
                <div className="p-3 rounded-lg bg-muted/50 border">
                  <p className="text-sm text-foreground break-words">{status}</p>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge className="h-6 py-0.5" variant="outline">
            <Palette className="h-3 w-3" />
            Image Tool
          </Badge>
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {actualAssistantTimestamp ? formatTimestamp(actualAssistantTimestamp) : ''}
        </div>
      </div>
    </Card>
  );
}
