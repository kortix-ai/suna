'use client';

import React, { useMemo } from 'react';
import {
  Image as ImageIcon,
  CheckCircle,
  AlertCircle,
  Wand2,
  ArrowUp,
  Eraser,
  PenTool,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';

const ACTION_CONFIG: Record<string, { label: string; icon: typeof Wand2 }> = {
  generate: { label: 'Generate Image', icon: Wand2 },
  edit: { label: 'Edit Image', icon: PenTool },
  upscale: { label: 'Upscale Image', icon: ArrowUp },
  remove_bg: { label: 'Remove Background', icon: Eraser },
};

function parseImageOutput(output: string): { path?: string; url?: string; error?: string } {
  if (!output) return {};
  try {
    const parsed = JSON.parse(output);
    return {
      path: parsed.path || parsed.image_path || parsed.output_path || parsed.file,
      url: parsed.url || parsed.image_url,
      error: parsed.error,
    };
  } catch {
    // Check if output itself is a file path
    const trimmed = output.trim();
    if (trimmed.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)) {
      return { path: trimmed };
    }
    if (trimmed.startsWith('http')) {
      return { url: trimmed };
    }
    if (trimmed.startsWith('Error:')) {
      return { error: trimmed.replace(/^Error:\s*/, '') };
    }
  }
  return {};
}

export function OcImageGenToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const action = (args.action as string) || (ocState?.input?.action as string) || 'generate';
  const prompt = (args.prompt as string) || (ocState?.input?.prompt as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);

  const isError = toolResult?.success === false || !!toolResult?.error;
  const parsed = useMemo(() => parseImageOutput(output), [output]);

  const config = ACTION_CONFIG[action] || ACTION_CONFIG.generate;
  const imageSource = parsed.url || parsed.path;

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title={config.label}
        subtitle={prompt.slice(0, 80)}
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={config.icon}
            title={config.label}
            subtitle={prompt.slice(0, 60)}
          />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3 space-y-3">
            {/* Image preview */}
            {imageSource && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageSource}
                  alt={prompt || 'Generated image'}
                  className="max-w-full max-h-[400px] rounded-lg border border-border object-contain"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
            )}

            {/* Prompt display */}
            {prompt && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground mb-1 font-medium">Prompt</p>
                <p className="text-sm text-foreground">{prompt}</p>
              </div>
            )}

            {/* Error */}
            {(isError || parsed.error) && (
              <div className="flex items-start gap-2.5 text-muted-foreground">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <p className="text-sm">{parsed.error || output || 'Image generation failed'}</p>
              </div>
            )}

            {/* File path */}
            {parsed.path && (
              <p className="text-[11px] text-muted-foreground/50 font-mono truncate px-1">
                {parsed.path}
              </p>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              {config.label}
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}
