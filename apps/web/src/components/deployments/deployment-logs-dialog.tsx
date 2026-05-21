'use client';

import React, { useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollText, Loader2 } from 'lucide-react';
import { useDeploymentLogs } from '@/hooks/deployments/use-deployments';
import type { Deployment } from '@/hooks/deployments/use-deployments';
import { cn } from '@/lib/utils';

// ─── Component ──────────────────────────────────────────────────────────────

interface DeploymentLogsDialogProps {
  deployment: Deployment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeploymentLogsDialog({
  deployment,
  open,
  onOpenChange,
}: DeploymentLogsDialogProps) {
  const { data, isLoading, error } = useDeploymentLogs(
    deployment?.deploymentId || '',
    open && !!deployment,
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when logs change
  useEffect(() => {
    if (scrollRef.current && data?.logs?.length) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data?.logs?.length]);

  const domain = deployment?.domains?.[0] || deployment?.deploymentId?.slice(0, 8) || 'Deployment';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col" aria-describedby="logs-description">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-5 w-5" />
            Deployment Logs
          </DialogTitle>
          <DialogDescription id="logs-description">
            Logs for {domain}
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto rounded-2xl bg-muted/30 border"
        >
          {isLoading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading logs...</span>
            </div>
          )}

          {error && (
            <div className="p-4 text-sm text-red-500 dark:text-red-400">
              Failed to load logs: {error instanceof Error ? error.message : 'Unknown error'}
            </div>
          )}

          {!isLoading && !error && (!data?.logs || data.logs.length === 0) && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <ScrollText className="h-8 w-8 mb-3 opacity-40" />
              <p className="text-sm">
                {data?.message || 'No logs available yet.'}
              </p>
            </div>
          )}

          {!isLoading && data?.logs && data.logs.length > 0 && (
            <div className="p-3 space-y-0.5 font-mono text-xs">
              {data.logs.map((log, i) => {
                const level = (log.level || 'info').toLowerCase();
                return (
                  <div
                    key={i}
                    className={cn(
                      'flex gap-2 px-2 py-0.5 rounded-sm hover:bg-muted/50',
                      level === 'error' && 'text-red-500 dark:text-red-400',
                      level === 'warn' || level === 'warning' ? 'text-yellow-600 dark:text-yellow-400' : '',
                    )}
                  >
                    {log.timestamp && (
                      <span className="text-muted-foreground shrink-0 w-[180px]">
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                    )}
                    <span className="break-all">{log.message || JSON.stringify(log)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
