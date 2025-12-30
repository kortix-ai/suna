'use client';

import React, { useMemo, useEffect, useRef } from 'react';

// Module-level Set to track which tool_call_ids we've already auto-opened
// Persists across component mounts within the same session
const autoOpenedToolCalls = new Set<string>();

// Module-level Set to track which tool_call_ids we've already emitted refresh events for
const refreshedToolCalls = new Set<string>();

// Global pending canvas refresh events (for when event is dispatched before listener is ready)
// This is stored on window so canvas-renderer can access it
declare global {
  interface Window {
    __pendingCanvasRefreshEvents?: Map<string, number>;
  }
}

// Initialize pending events map
if (typeof window !== 'undefined' && !window.__pendingCanvasRefreshEvents) {
  window.__pendingCanvasRefreshEvents = new Map();
}

// Emit custom event to trigger canvas refresh when tool modifies canvas
function emitCanvasRefresh(canvasPath: string) {
  console.log('[CANVAS_LIVE_DEBUG] emitCanvasRefresh called with path:', canvasPath);
  
  // Store in pending events queue (canvas-renderer will check this when it mounts)
  if (window.__pendingCanvasRefreshEvents) {
    window.__pendingCanvasRefreshEvents.set(canvasPath, Date.now());
    console.log('[CANVAS_LIVE_DEBUG] Added to pending events queue:', canvasPath);
  }
  
  const event = new CustomEvent('canvas-tool-updated', { 
    detail: { canvasPath, timestamp: Date.now() } 
  });
  console.log('[CANVAS_LIVE_DEBUG] Dispatching canvas-tool-updated event');
  window.dispatchEvent(event);
}
import {
  Layout,
  ImagePlus,
  CheckCircle,
  AlertTriangle,
  Layers,
  Loader2,
  Sparkles,
  Save,
  Trash2,
  Edit3,
  MousePointerClick,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { extractCanvasData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useImageContent } from '@/hooks/files';

interface CanvasToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

const BLOB_COLORS = [
  'from-purple-300/60 to-pink-300/60',
  'from-blue-300/60 to-cyan-300/60',
  'from-emerald-300/60 to-teal-300/60',
  'from-orange-300/60 to-amber-300/60',
];

function ShimmerBox({ className }: { className?: string }) {
  const colorClass = useMemo(() => BLOB_COLORS[Math.floor(Math.random() * BLOB_COLORS.length)], []);

  return (
    <div className={cn("relative rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-700/50", className)}>
      {/* Background blob - use inset-[-50%] instead of scale to prevent overflow */}
      <div className={`absolute inset-[-50%] bg-gradient-to-br ${colorClass} blur-2xl rounded-2xl`} />
      <div className="absolute inset-0 bg-zinc-100/30 dark:bg-zinc-900/30 backdrop-blur-sm rounded-2xl" />
      <div
        className="absolute inset-0 rounded-2xl"
        style={{
          background: 'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.4) 50%, transparent 70%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.8s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

function ImagePreview({ imagePath, sandboxId }: { imagePath: string; sandboxId?: string }) {
  const { data: imageUrl, isLoading } = useImageContent(sandboxId, imagePath, {
    enabled: !!sandboxId && !!imagePath,
  });

  if (isLoading || !imageUrl) {
    return <ShimmerBox className="w-full aspect-video" />;
  }

  return (
    <img
      src={imageUrl}
      alt={imagePath}
      className="w-full rounded-2xl border border-neutral-200 dark:border-neutral-700/50 object-cover aspect-video"
    />
  );
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

  const toolName = toolCall?.function_name || '';
  const args = toolCall?.arguments || {};

  // Check if this is a create canvas action (explicit create_canvas tool)
  const isExplicitCreateCanvas = toolName.includes('create_canvas') || toolName.includes('create-canvas');
  // Check if this is image generation that adds to canvas
  const isImageGenToCanvas = (toolName.includes('image_edit') || toolName.includes('image-edit')) && args.canvas_path;
  // Any operation that involves a canvas path should auto-open
  const hasCanvasPath = !!(args.canvas_path || canvasPath);

  // Get tool_call_id for tracking
  const toolCallId = toolCall?.tool_call_id;

  // Check if result is recent (within last 30 seconds) - to distinguish live ops from history
  // This is when the RESULT was received, not when the tool started, so even 60s tools work
  // IMPORTANT: If toolTimestamp is undefined, assume it's a live operation (not old history)
  const toolTimestampMs = toolTimestamp ? new Date(toolTimestamp).getTime() : 0;
  const hasValidTimestamp = !!toolTimestamp && toolTimestampMs > 0;
  const isRecentResult = !hasValidTimestamp || (Date.now() - toolTimestampMs) < 30000;

  // Debug logging on mount and updates
  useEffect(() => {
    console.log('[CANVAS_LIVE_DEBUG] CanvasToolView mounted/updated', {
      toolName,
      toolCallId,
      hasCanvasPath,
      hasToolResult: !!toolResult,
      toolResultKeys: toolResult ? Object.keys(toolResult) : null,
      actualIsSuccess,
      isStreaming,
      canvasPath,
      canvasName,
      argsCanvasPath: args.canvas_path,
      hasOnFileClick: !!onFileClick,
      hasValidTimestamp,
      isRecentResult,
      toolTimestampMs,
      nowMs: Date.now(),
      alreadyAutoOpened: toolCallId ? autoOpenedToolCalls.has(toolCallId) : false,
      alreadyRefreshed: toolCallId ? refreshedToolCalls.has(toolCallId) : false,
    });
  });
  
  // Log when toolResult changes
  useEffect(() => {
    if (toolResult) {
      console.log('[CANVAS_LIVE_DEBUG] toolResult received:', {
        toolCallId,
        toolName,
        success: toolResult.success,
        outputType: typeof toolResult.output,
        outputPreview: toolResult.output ? (typeof toolResult.output === 'string' ? toolResult.output.substring(0, 200) : JSON.stringify(toolResult.output).substring(0, 200)) : null,
      });
    }
  }, [toolResult, toolCallId, toolName]);

  // Auto-open canvas editor when tool completes
  // Uses tool_call_id to ensure we only open once per tool call
  // Uses timestamp to distinguish live operations from viewing old history
  useEffect(() => {
    const path = canvasPath || args.canvas_path || (canvasName ? `canvases/${canvasName}.kanvax` : null);
    // If no valid timestamp, assume it's a live operation (not old history)
    const recentCheck = !hasValidTimestamp || (Date.now() - toolTimestampMs) < 30000;

    console.log('[CanvasToolView] Effect triggered', {
      toolCallId,
      hasToolResult: !!toolResult,
      actualIsSuccess,
      hasCanvasPath,
      hasOnFileClick: !!onFileClick,
      hasPath: !!path,
      hasValidTimestamp,
      isRecentResult: recentCheck,
      alreadyAutoOpened: toolCallId ? autoOpenedToolCalls.has(toolCallId) : false,
      path,
    });

    // Skip if we've already auto-opened this specific tool call
    if (toolCallId && autoOpenedToolCalls.has(toolCallId)) {
      console.log('[CanvasToolView] Skipping: already auto-opened tool_call_id:', toolCallId);
      return;
    }

    // Skip if result is old (viewing history after page refresh)
    // Note: If no timestamp is available, we assume it's live and don't skip
    if (!recentCheck) {
      console.log('[CanvasToolView] Skipping: result is old (viewing history)', {
        toolTimestampMs,
        hasValidTimestamp,
        nowMs: Date.now(),
        diffMs: Date.now() - toolTimestampMs,
      });
      return;
    }

    // Auto-open if we have all conditions
    if (
      toolCallId &&
      toolResult &&
      actualIsSuccess &&
      hasCanvasPath &&
      onFileClick &&
      path
    ) {
      console.log('[CanvasToolView] Auto-opening canvas:', path);
      autoOpenedToolCalls.add(toolCallId);
      // Delay to let user see the success state briefly before opening canvas
      setTimeout(() => {
        console.log('[CanvasToolView] Executing onFileClick for:', path);
        onFileClick(path);
      }, 500);
    } else {
      console.log('[CanvasToolView] Not auto-opening, missing conditions:', {
        hasToolCallId: !!toolCallId,
        hasToolResult: !!toolResult,
        actualIsSuccess,
        hasCanvasPath,
        hasOnFileClick: !!onFileClick,
        hasPath: !!path,
      });
    }
  }, [toolCallId, toolResult, actualIsSuccess, hasCanvasPath, onFileClick, canvasPath, canvasName, args.canvas_path, toolTimestampMs, hasValidTimestamp]);

  // Emit canvas refresh event when tool completes (for live updates during streaming)
  useEffect(() => {
    const path = canvasPath || args.canvas_path || (canvasName ? `canvases/${canvasName}.kanvax` : null);
    
    console.log('[CANVAS_LIVE_DEBUG] Refresh effect triggered:', {
      toolCallId,
      toolName,
      hasToolResult: !!toolResult,
      toolResultOutput: toolResult?.output ? (typeof toolResult.output === 'string' ? toolResult.output.substring(0, 100) : JSON.stringify(toolResult.output).substring(0, 100)) : null,
      actualIsSuccess,
      path,
      alreadyRefreshed: toolCallId ? refreshedToolCalls.has(toolCallId) : false,
      isStreaming,
    });
    
    // Skip if already emitted for this tool call
    if (toolCallId && refreshedToolCalls.has(toolCallId)) {
      console.log('[CANVAS_LIVE_DEBUG] Skipping - already emitted refresh for:', toolCallId);
      return;
    }
    
    // Emit refresh when tool completes successfully with canvas changes
    if (toolCallId && toolResult && actualIsSuccess && path) {
      console.log('[CANVAS_LIVE_DEBUG] Will emit refresh in 200ms for:', path);
      refreshedToolCalls.add(toolCallId);
      // Small delay to ensure file is written
      setTimeout(() => {
        console.log('[CANVAS_LIVE_DEBUG] Executing delayed emitCanvasRefresh for:', path);
        emitCanvasRefresh(path);
      }, 200);
    } else {
      console.log('[CANVAS_LIVE_DEBUG] NOT emitting refresh - missing conditions:', {
        hasToolCallId: !!toolCallId,
        hasToolResult: !!toolResult,
        actualIsSuccess,
        hasPath: !!path,
      });
    }
  }, [toolCallId, toolResult, actualIsSuccess, canvasPath, canvasName, args.canvas_path, toolName, isStreaming]);

  // Determine what action was taken
  const getActionInfo = () => {
    // Explicit create_canvas or image gen that creates/adds to canvas
    if (isExplicitCreateCanvas || isImageGenToCanvas) {
      return {
        icon: Sparkles,
        title: 'Canvas Created',
        color: 'text-purple-600 dark:text-purple-400',
        bgColor: 'bg-purple-200/60 dark:bg-purple-900',
        borderColor: 'border-purple-300 dark:border-purple-700',
      };
    }
    if (toolName.includes('add_image') || toolName.includes('add-image')) {
      return {
        icon: ImagePlus,
        title: 'Image Added',
        color: 'text-blue-600 dark:text-blue-400',
        bgColor: 'bg-blue-200/60 dark:bg-blue-900',
        borderColor: 'border-blue-300 dark:border-blue-700',
      };
    }
    if (toolName.includes('list_canvas') || toolName.includes('list-canvas')) {
      return {
        icon: Layers,
        title: 'Elements Listed',
        color: 'text-zinc-600 dark:text-zinc-400',
        bgColor: 'bg-zinc-200/60 dark:bg-zinc-900',
        borderColor: 'border-zinc-300 dark:border-zinc-700',
      };
    }
    if (toolName.includes('save_canvas') || toolName.includes('save-canvas')) {
      return {
        icon: Save,
        title: 'Canvas Saved',
        color: 'text-green-600 dark:text-green-400',
        bgColor: 'bg-green-200/60 dark:bg-green-900',
        borderColor: 'border-green-300 dark:border-green-700',
      };
    }
    if (toolName.includes('remove_canvas') || toolName.includes('remove-canvas')) {
      return {
        icon: Trash2,
        title: 'Element Removed',
        color: 'text-rose-600 dark:text-rose-400',
        bgColor: 'bg-rose-200/60 dark:bg-rose-900',
        borderColor: 'border-rose-300 dark:border-rose-700',
      };
    }
    if (toolName.includes('update_canvas') || toolName.includes('update-canvas')) {
      return {
        icon: Edit3,
        title: 'Element Updated',
        color: 'text-amber-600 dark:text-amber-400',
        bgColor: 'bg-amber-200/60 dark:bg-amber-900',
        borderColor: 'border-amber-300 dark:border-amber-700',
      };
    }
    return {
      icon: Layout,
      title: 'Canvas Operation',
      color: 'text-zinc-600 dark:text-zinc-400',
      bgColor: 'bg-zinc-200/60 dark:bg-zinc-900',
      borderColor: 'border-zinc-300 dark:border-zinc-700',
    };
  };

  const actionInfo = getActionInfo();
  const IconComponent = actionInfo.icon;

  // Check if we have an image to show
  const isAddImage = toolName.includes('add_image') || toolName.includes('add-image');
  const addedImagePath = isAddImage ? (args.image_path || args.name) : null;
  const sandboxId = project?.sandbox?.id;

  // Handle click to open canvas file
  const handleOpenCanvas = () => {
    if (onFileClick) {
      // Use canvasPath if available, otherwise construct from canvasName
      const path = canvasPath || (canvasName ? `canvases/${canvasName}.kanvax` : null);
      if (path) {
        onFileClick(path);
      }
    }
  };

  if (!toolCall) return null;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      {/* Header */}
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn(
              "relative p-2 rounded-lg border flex-shrink-0",
              actionInfo.bgColor,
              actionInfo.borderColor
            )}>
              <IconComponent className={cn("w-5 h-5", actionInfo.color)} />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {actionInfo.title}
              </CardTitle>
            </div>
          </div>

          <div className="flex items-center gap-2">
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
                  <>
                    <CheckCircle className="h-3.5 w-3.5 mr-1" />
                    Success
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                    Failed
                  </>
                )}
              </Badge>
            )}

            {isStreaming && (
              <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Processing
              </Badge>
            )}

            {/* Open canvas button in header */}
            {(canvasPath || canvasName) && !isStreaming && (
              <Button
                onClick={handleOpenCanvas}
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2"
              >
                <MousePointerClick className="h-3.5 w-3.5" />
                <span className="text-xs hidden sm:inline">Open Canvas</span>
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      {/* Content */}
      <CardContent className="p-4">
        {isStreaming ? (
          <ShimmerBox className="w-full h-32" />
        ) : !actualIsSuccess ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3 bg-gradient-to-b from-rose-100 to-rose-50 dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-6 w-6 text-rose-500 dark:text-rose-400" />
            </div>
            <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1">
              Operation Failed
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {error || 'An error occurred during the canvas operation'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Show image preview if adding image */}
            {isAddImage && addedImagePath && (
              <ImagePreview imagePath={addedImagePath} sandboxId={sandboxId} />
            )}

            {/* Canvas info */}
            <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Layout className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium truncate">
                  {canvasName || canvasPath?.split('/').pop() || 'Canvas'}
                </span>
              </div>
              {totalElements !== undefined && totalElements > 0 && (
                <Badge variant="secondary" className="ml-2 shrink-0">
                  <Layers className="h-3 w-3 mr-1" />
                  {totalElements}
                </Badge>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
