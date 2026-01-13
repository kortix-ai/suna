'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Table, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SpreadsheetViewer } from '@/components/thread/tool-views/spreadsheet/SpreadsheetViewer';

// Example prompts for sheets mode
const examplePrompts = [
  {
    label: 'Analyze website traffic data and visualize conversion funnels',
    prompt: 'Initialize the tools. Analyze website traffic data and visualize conversion funnels.',
  },
  {
    label: 'Develop a hiring tracker with pipeline metrics and time-to-fill analysis',
    prompt: 'Initialize the tools. Develop a hiring tracker with pipeline metrics and time-to-fill analysis.',
  },
  {
    label: 'Design a content calendar tracking campaigns with ROI and engagement charts',
    prompt: 'Initialize the tools. Design a content calendar tracking campaigns with ROI and engagement charts.',
  },
  {
    label: 'Build a cohort analysis showing user retention and churn patterns',
    prompt: 'Initialize the tools. Build a cohort analysis showing user retention and churn patterns.',
  },
];

interface SheetsModeStarterProps {
  onSelectPrompt: (prompt: string, placeholderInfo?: { start: number; end: number }) => void;
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
  onSelectPrompt,
  onClose,
  className,
  sandboxId,
  project,
}: SheetsModeStarterProps) {
  const [showSpreadsheet, setShowSpreadsheet] = useState(false);
  const [filePath, setFilePath] = useState<string | undefined>(undefined);

  useEffect(() => {
    const timer1 = setTimeout(() => {
      setShowSpreadsheet(true);
    }, 100);

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
          <h2 className="text-base font-semibold text-foreground">AI Sheets</h2>
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

      {/* Content - 50/50 split */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Top half - Prompts */}
        <div className="flex-1 overflow-y-auto border-b border-border/30">
          <div className="p-5 space-y-2">
            {examplePrompts.map((item, index) => (
              <motion.button
                key={index}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05, duration: 0.2 }}
                onClick={() => {
                  console.log('[SheetsModeStarter] Prompt clicked:', item.prompt);
                  onSelectPrompt(item.prompt);
                }}
                className={cn(
                  'w-full text-left px-4 py-3 rounded-xl',
                  'bg-muted/30 hover:bg-muted/50 border border-transparent hover:border-border/50',
                  'transition-all duration-150 cursor-pointer',
                  'text-sm text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="line-clamp-2">{item.label}</span>
              </motion.button>
            ))}
          </div>
        </div>

        {/* Bottom half - Spreadsheet Viewer */}
        <div className="flex-1 min-h-0">
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
            <div className="h-full flex items-center justify-center bg-background/50">
              <div className="flex items-center gap-2 text-muted-foreground">
                <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">Loading spreadsheet...</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
