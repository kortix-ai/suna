'use client';

import React, { useState, useEffect } from 'react';
import { Table, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SpreadsheetViewer } from '@/components/thread/tool-views/spreadsheet/SpreadsheetViewer';

interface SheetsModeStarterProps {
  onClose?: () => void;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
    };
  };
}

export function SheetsModeStarter({
  onClose,
  className,
  sandboxId,
  project,
}: SheetsModeStarterProps) {
  const [showSpreadsheet, setShowSpreadsheet] = useState(false);
  const [filePath, setFilePath] = useState<string | undefined>(undefined);

  // Try to load the CSV file that was uploaded
  useEffect(() => {
    const timer1 = setTimeout(() => {
      setShowSpreadsheet(true);
    }, 100);
    
      // The Excel file should be at /workspace/uploads/spreadsheet.xlsx
      // Try to set it after a short delay to allow file upload to complete
      const timer2 = setTimeout(() => {
        setFilePath('/workspace/uploads/spreadsheet.xlsx');
      }, 600);
    
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, []);

  return (
    <div className={cn(
      'relative flex flex-col h-full min-h-0 bg-card/95 dark:bg-card/90 backdrop-blur-sm rounded-2xl overflow-hidden border border-border/50',
      className
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10">
            <Table className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">AI Sheets</h2>
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

      {/* Spreadsheet Viewer */}
      <div className="flex-1 min-h-0 relative">
        {showSpreadsheet ? (
          <SpreadsheetViewer
            filePath={filePath}
            fileName={filePath ? "spreadsheet.xlsx" : "New Spreadsheet"}
            sandboxId={sandboxId}
            project={project}
            showToolbar={false}
            allowEditing={false}
            className="h-full"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50">
            <div className="flex items-center gap-2 text-muted-foreground">
              <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Loading spreadsheet...</span>
            </div>
          </div>
        )}
        
        {/* Overlay message */}
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 dark:bg-background/70 backdrop-blur-[1px] pointer-events-none">
          <div className="text-center px-4 bg-card/90 backdrop-blur-sm rounded-xl p-6 border border-border/50">
            <Table className="w-8 h-8 mx-auto mb-3 text-emerald-500/60" />
            <p className="text-sm font-medium text-foreground mb-1">
              Your AI spreadsheet awaits
            </p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Describe what you want to create in the chat below and watch as AI populates your spreadsheet
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
