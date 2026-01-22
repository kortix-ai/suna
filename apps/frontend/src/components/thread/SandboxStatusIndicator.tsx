'use client';

import { useSandboxStatusWithAutoStart } from '@/hooks/files/use-sandbox-details';
import { getSandboxStatusLabel } from '@/hooks/files/use-sandbox-details';
import { cn } from '@/lib/utils';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface SandboxStatusIndicatorProps {
  projectId: string | undefined;
  className?: string;
}

/**
 * Simple sandbox status indicator badge for header/status bar
 * Shows LIVE/STARTING/OFFLINE/UNKNOWN status with appropriate colors
 */
export function SandboxStatusIndicator({ projectId, className }: SandboxStatusIndicatorProps) {
  const { data: sandboxState, isLoading } = useSandboxStatusWithAutoStart(projectId, {
    enabled: !!projectId,
  });

  if (!projectId || isLoading) {
    return null;
  }

  const status = sandboxState?.status || 'UNKNOWN';

  // Get color classes for status
  const getStatusStyles = (status: string) => {
    switch (status) {
      case 'LIVE':
        return 'bg-chart-2/10 text-chart-2 border-chart-2/20';
      case 'STARTING':
        return 'bg-chart-3/10 text-chart-3 border-chart-3/20';
      case 'OFFLINE':
        return 'bg-muted text-muted-foreground border-border';
      case 'FAILED':
        return 'bg-destructive/10 text-destructive border-destructive/20';
      case 'UNKNOWN':
      default:
        return 'bg-muted/50 text-muted-foreground border-border opacity-50';
    }
  };

  // Status indicator icon
  const StatusIcon = () => {
    switch (status) {
      case 'LIVE':
        return (
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-2 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-chart-2" />
          </span>
        );
      case 'STARTING':
        return <Loader2 className="h-3 w-3 animate-spin" />;
      case 'FAILED':
        return <AlertTriangle className="h-3 w-3" />;
      case 'OFFLINE':
      case 'UNKNOWN':
      default:
        return <span className="h-1.5 w-1.5 rounded-full bg-current" />;
    }
  };

  const statusLabel = getSandboxStatusLabel(status);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium',
              getStatusStyles(status),
              className
            )}
          >
            <StatusIcon />
            <span>{statusLabel}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>Sandbox Status: {statusLabel}</p>
          {sandboxState?.sandbox_id && (
            <p className="text-xs text-muted-foreground mt-1">ID: {sandboxState.sandbox_id.slice(0, 8)}...</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
