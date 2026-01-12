'use client';

import React, { useState, useEffect } from 'react';
import { PenTool, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CanvasRenderer } from '@/components/file-renderers/canvas-renderer';
import { useFileContentQuery } from '@/hooks/files/use-file-queries';

interface CanvasModeStarterProps {
  onClose?: () => void;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
    };
  };
}

export function CanvasModeStarter({
  onClose,
  className,
  sandboxId,
  project,
}: CanvasModeStarterProps) {
  const filePath = '/workspace/uploads/initial.kanvax';
  const fileName = 'initial.kanvax';
  
  // Load canvas file content
  const { 
    data: canvasContent, 
    isLoading: isLoadingContent,
  } = useFileContentQuery(sandboxId, filePath, {
    enabled: !!sandboxId,
    contentType: 'text',
  });

  return (
    <div className={cn(
      'relative flex flex-col h-full min-h-0 bg-card/95 dark:bg-card/90 backdrop-blur-sm rounded-2xl overflow-hidden border border-border/50',
      className
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-500/10">
            <PenTool className="w-4 h-4 text-violet-600 dark:text-violet-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">AI Canvas</h2>
            <p className="text-xs text-muted-foreground">Describe what you need in the chat below</p>
          </div>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Canvas Renderer */}
      <div className="flex-1 min-h-0 relative">
        {isLoadingContent ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50">
            <div className="flex items-center gap-2 text-muted-foreground">
              <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Loading canvas...</span>
            </div>
          </div>
        ) : (
          <CanvasRenderer
            content={typeof canvasContent === 'string' ? canvasContent : ''}
            filePath={filePath}
            fileName={fileName}
            sandboxId={sandboxId}
            className="h-full w-full"
          />
        )}
      </div>
    </div>
  );
}
