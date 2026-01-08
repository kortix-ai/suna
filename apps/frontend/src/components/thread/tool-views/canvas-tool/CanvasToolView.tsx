'use client';

import React, { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import {
  Layout,
  ImagePlus,
  AlertTriangle,
  Layers,
  Sparkles,
  Save,
  Trash2,
  Edit3,
  ExternalLink,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { extractCanvasData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useFileContent } from '@/hooks/files';
import { CanvasRenderer } from '@/components/file-renderers/canvas-renderer';
import { formatTimestamp } from '../utils';

// Module-level Set to track which tool_call_ids we've already emitted refresh events for
const refreshedToolCalls = new Set<string>();

// Global pending canvas refresh events (for when event is dispatched before listener is ready)
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
  if (window.__pendingCanvasRefreshEvents) {
    window.__pendingCanvasRefreshEvents.set(canvasPath, Date.now());
  }
  
  const event = new CustomEvent('canvas-tool-updated', { 
    detail: { canvasPath, timestamp: Date.now() } 
  });
  window.dispatchEvent(event);
}

interface CanvasToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

const BLOB_COLORS = [
  'from-zinc-300/60 to-zinc-400/60',
  'from-zinc-200/60 to-zinc-300/60',
];

function ShimmerBox({ className }: { className?: string }) {
  const colorClass = useMemo(() => BLOB_COLORS[Math.floor(Math.random() * BLOB_COLORS.length)], []);

  return (
    <div className={cn("relative rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-700", className)}>
      <div className={`absolute inset-[-50%] bg-gradient-to-br ${colorClass} blur-2xl rounded-lg`} />
      <div className="absolute inset-0 bg-zinc-100/30 dark:bg-zinc-900/30 backdrop-blur-sm rounded-lg" />
      <div
        className="absolute inset-0 rounded-lg"
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

/**
 * Canvas Tool View - Shows the canvas inline with full editing capability
 * Similar to PresentationViewer showing slides inline
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
  const [refreshKey, setRefreshKey] = useState(0);
  const lastRefreshRef = useRef<number>(0);
  
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

  // Determine the full canvas file path
  const resolvedCanvasPath = useMemo(() => {
    const path = canvasPath || args.canvas_path || (canvasName ? `canvases/${canvasName}.kanvax` : null);
    if (!path) return null;
    
    // Normalize path to include /workspace if needed
    if (path.startsWith('/workspace/')) return path;
    if (path.startsWith('workspace/')) return '/' + path;
    return `/workspace/${path.replace(/^\//, '')}`;
  }, [canvasPath, args.canvas_path, canvasName]);

  const fileName = resolvedCanvasPath?.split('/').pop() || 'Canvas';
  const sandboxId = project?.sandbox?.id;

  // Load canvas file content
  const { 
    data: canvasContent, 
    isLoading: isLoadingContent,
    refetch: refetchContent,
  } = useFileContent(sandboxId, resolvedCanvasPath || undefined, {
    enabled: !!sandboxId && !!resolvedCanvasPath && !isStreaming && actualIsSuccess,
  });

  // Get tool_call_id for tracking
  const toolCallId = toolCall?.tool_call_id;

  // Check if this is a create canvas action
  const isExplicitCreateCanvas = toolName.includes('create_canvas') || toolName.includes('create-canvas');
  const isImageGenToCanvas = (toolName.includes('image_edit') || toolName.includes('image-edit')) && args.canvas_path;

  // Emit canvas refresh event when tool completes
  useEffect(() => {
    if (toolCallId && refreshedToolCalls.has(toolCallId)) return;
    
    if (toolCallId && toolResult && actualIsSuccess && resolvedCanvasPath) {
      refreshedToolCalls.add(toolCallId);
      setTimeout(() => {
        emitCanvasRefresh(resolvedCanvasPath);
        // Also refetch content after a small delay
        setTimeout(() => {
          refetchContent();
          setRefreshKey(k => k + 1);
        }, 300);
      }, 200);
    }
  }, [toolCallId, toolResult, actualIsSuccess, resolvedCanvasPath, refetchContent]);

  // Listen for canvas updates from other tool calls
  useEffect(() => {
    if (!resolvedCanvasPath) return;
    
    const handleCanvasUpdate = (event: CustomEvent) => {
      const { canvasPath: updatedPath, timestamp } = event.detail;
      // Check if this update is for our canvas and is newer than last refresh
      if (updatedPath === resolvedCanvasPath && timestamp > lastRefreshRef.current) {
        lastRefreshRef.current = timestamp;
        refetchContent();
        setRefreshKey(k => k + 1);
      }
    };

    window.addEventListener('canvas-tool-updated', handleCanvasUpdate as EventListener);
    return () => {
      window.removeEventListener('canvas-tool-updated', handleCanvasUpdate as EventListener);
    };
  }, [resolvedCanvasPath, refetchContent]);

  // Determine action info for header
  const getActionInfo = () => {
    const baseStyle = {
      color: 'text-zinc-700 dark:text-zinc-300',
      bgColor: 'bg-zinc-100 dark:bg-zinc-800',
      borderColor: 'border-zinc-200 dark:border-zinc-700',
    };
    
    if (isExplicitCreateCanvas || isImageGenToCanvas) {
      return { icon: Sparkles, title: 'Canvas', ...baseStyle };
    }
    if (toolName.includes('add_image') || toolName.includes('add-image')) {
      return { icon: ImagePlus, title: 'Canvas', ...baseStyle };
    }
    if (toolName.includes('list_canvas') || toolName.includes('list-canvas')) {
      return { icon: Layers, title: 'Canvas', ...baseStyle };
    }
    if (toolName.includes('save_canvas') || toolName.includes('save-canvas')) {
      return { icon: Save, title: 'Canvas', ...baseStyle };
    }
    if (toolName.includes('remove_canvas') || toolName.includes('remove-canvas')) {
      return { icon: Trash2, title: 'Canvas', ...baseStyle };
    }
    if (toolName.includes('update_canvas') || toolName.includes('update-canvas')) {
      return { icon: Edit3, title: 'Canvas', ...baseStyle };
    }
    return { icon: Layout, title: 'Canvas', ...baseStyle };
  };

  const actionInfo = getActionInfo();
  const IconComponent = actionInfo.icon;

  // Handle opening in file viewer (for fullscreen/expanded view)
  const handleOpenInViewer = useCallback(() => {
    if (onFileClick && resolvedCanvasPath) {
      // Remove /workspace prefix for onFileClick
      const pathForClick = resolvedCanvasPath.replace(/^\/workspace\//, '');
      onFileClick(pathForClick);
    }
  }, [onFileClick, resolvedCanvasPath]);

  // Get clean canvas name for display
  const displayName = useMemo(() => {
    const raw = canvasName || canvasPath?.split('/').pop() || fileName || 'Canvas';
    return raw.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '').replace(/\.kanvax$/, '') || 'Canvas';
  }, [canvasName, canvasPath, fileName]);

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
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {displayName}
              </CardTitle>
              {isStreaming && (
                <span className="inline-block h-3 w-3 rounded-full border border-zinc-400 border-t-zinc-600 animate-spin" />
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {totalElements !== undefined && totalElements > 0 && (
              <Badge variant="secondary" className="shrink-0">
                <Layers className="h-3 w-3 mr-1" />
                {totalElements}
              </Badge>
            )}
            {resolvedCanvasPath && !isStreaming && actualIsSuccess && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenInViewer}
                className="h-8 w-8 p-0"
                title="Open in file viewer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      {/* Canvas Content */}
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex items-center justify-center h-full min-h-[300px]">
            <ShimmerBox className="w-full h-full min-h-[300px]" />
          </div>
        ) : !actualIsSuccess ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-gradient-to-b from-zinc-100 to-zinc-50 dark:from-zinc-800/40 dark:to-zinc-900/60">
              <AlertTriangle className="h-8 w-8 text-zinc-500 dark:text-zinc-400" />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
              Operation Failed
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 text-center max-w-md">
              {error || 'An error occurred during the canvas operation'}
            </p>
          </div>
        ) : isLoadingContent ? (
          <div className="flex items-center justify-center h-full min-h-[300px]">
            <ShimmerBox className="w-full h-full min-h-[300px]" />
          </div>
        ) : canvasContent ? (
          <div className="h-full min-h-[400px]" key={refreshKey}>
            <CanvasRenderer
              content={typeof canvasContent === 'string' ? canvasContent : ''}
              filePath={resolvedCanvasPath || ''}
              fileName={fileName}
              sandboxId={sandboxId}
              className="h-full w-full"
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-gradient-to-b from-zinc-100 to-zinc-50 dark:from-zinc-800/40 dark:to-zinc-900/60">
              <Layout className="h-8 w-8 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
              Canvas Empty
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 text-center max-w-md">
              This canvas doesn't have any content yet.
            </p>
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-9 bg-muted/20 border-t border-border/40 flex justify-between items-center">
        <div className="text-xs text-muted-foreground font-mono">
          {resolvedCanvasPath?.replace('/workspace/', '')}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatTimestamp(toolTimestamp)}
        </div>
      </div>
    </Card>
  );
}
