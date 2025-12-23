'use client';

import React from 'react';
import {
  Layout,
  ImagePlus,
  Check,
  X,
  Layers,
  FileImage,
  Loader2,
  Sparkles,
  Save,
  Trash2,
  Edit3,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { extractCanvasData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface CanvasToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

/**
 * Canvas Tool View - Shows PREVIEW of what the tool did
 * Click to open the live editor in file viewer
 */
export function CanvasToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  onFileClick,
}: CanvasToolViewProps) {
  const extractedData = toolCall ? extractCanvasData(
    toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp
  ) : null;

  const { 
    canvasName, 
    canvasPath, 
    totalElements,
    actualIsSuccess,
    error 
  } = extractedData || {};

  const toolName = toolCall?.function_name || toolCall?.name || '';

  // Determine what action was taken
  const getActionInfo = () => {
    if (toolName.includes('create_canvas') || toolName.includes('create-canvas')) {
      return {
        icon: <Sparkles className="h-4 w-4" />,
        title: 'Canvas Created',
        badge: 'Created',
        badgeVariant: 'default' as const,
        description: canvasName ? `"${canvasName}"` : 'New canvas',
      };
    }
    if (toolName.includes('add_image') || toolName.includes('add-image')) {
      const args = toolCall?.arguments || {};
      return {
        icon: <ImagePlus className="h-4 w-4" />,
        title: 'Image Added',
        badge: 'Added',
        badgeVariant: 'secondary' as const,
        description: args.name || args.image_path?.split('/').pop() || 'Image added',
      };
    }
    if (toolName.includes('list_canvas') || toolName.includes('list-canvas')) {
      return {
        icon: <Layers className="h-4 w-4" />,
        title: 'Canvas Elements',
        badge: `${totalElements || 0} elements`,
        badgeVariant: 'outline' as const,
        description: canvasName || 'Listed elements',
      };
    }
    if (toolName.includes('save_canvas') || toolName.includes('save-canvas')) {
      return {
        icon: <Save className="h-4 w-4" />,
        title: 'Canvas Saved',
        badge: 'Saved',
        badgeVariant: 'default' as const,
        description: canvasPath || 'Changes saved',
      };
    }
    if (toolName.includes('remove_canvas') || toolName.includes('remove-canvas')) {
      return {
        icon: <Trash2 className="h-4 w-4" />,
        title: 'Element Removed',
        badge: 'Removed',
        badgeVariant: 'destructive' as const,
        description: 'Element removed from canvas',
      };
    }
    if (toolName.includes('update_canvas') || toolName.includes('update-canvas')) {
      return {
        icon: <Edit3 className="h-4 w-4" />,
        title: 'Element Updated',
        badge: 'Updated',
        badgeVariant: 'secondary' as const,
        description: 'Canvas element updated',
      };
    }
    return {
      icon: <Layout className="h-4 w-4" />,
      title: 'Canvas Operation',
      badge: 'Done',
      badgeVariant: 'outline' as const,
      description: canvasPath || 'Operation completed',
    };
  };

  const actionInfo = getActionInfo();

  // Handle click to open canvas file
  const handleOpenCanvas = () => {
    if (canvasPath && onFileClick) {
      onFileClick(canvasPath);
    }
  };

  // Streaming state
  if (isStreaming) {
    return (
      <Card className="w-full border-border/50 bg-card/50">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-primary/10">
              <Loader2 className="h-5 w-5 text-primary animate-spin" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">Processing canvas...</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Please wait
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (!actualIsSuccess) {
    return (
      <Card className="w-full border-destructive/30 bg-destructive/5">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-destructive/10">
              <X className="h-5 w-5 text-destructive" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm text-destructive">Operation Failed</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {error || 'An error occurred'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Success state
  return (
    <Card 
      className={cn(
        "w-full border-border/50 bg-card/50 transition-all duration-200",
        canvasPath && "hover:border-primary/30 hover:bg-accent/30 cursor-pointer"
      )}
      onClick={canvasPath ? handleOpenCanvas : undefined}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          {/* Icon */}
          <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-primary/10 text-primary shrink-0">
            {actionInfo.icon}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{actionInfo.title}</span>
              <Badge variant={actionInfo.badgeVariant} className="text-[10px] px-1.5 py-0">
                {actionInfo.badge}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {actionInfo.description}
            </p>
          </div>

          {/* Action hint */}
          {canvasPath && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              <FileImage className="h-3.5 w-3.5" />
              <span>Click to edit</span>
            </div>
          )}
        </div>

        {/* Elements count if available */}
        {totalElements !== undefined && totalElements > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" />
                {totalElements} element{totalElements !== 1 ? 's' : ''}
              </span>
              {canvasPath && (
                <span className="flex items-center gap-1.5">
                  <FileImage className="h-3.5 w-3.5" />
                  {canvasPath}
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
