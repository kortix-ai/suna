'use client';

import { useState, useEffect } from 'react';
import { useSandboxStatus, useStartSandbox } from '@/hooks/files/use-sandbox-details';
import { Button } from '@/components/ui/button';
import { Loader2, Power, AlertTriangle, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SandboxStatusViewProps {
  projectId: string | undefined;
  className?: string;
}

/**
 * Sandbox status view shown in Files tab when sandbox is not LIVE
 * Shows a simple "Start Computer" button for any non-running state
 */
export function SandboxStatusView({ projectId, className }: SandboxStatusViewProps) {
  const { data: sandboxState, isLoading } = useSandboxStatus(projectId, {
    enabled: !!projectId,
  });
  const startSandbox = useStartSandbox();
  const [isCreating, setIsCreating] = useState(false);

  const status = sandboxState?.status || 'OFFLINE';

  // Reset creating state when status changes to something definitive
  useEffect(() => {
    if (isCreating && (status === 'LIVE' || status === 'FAILED' || status === 'STARTING')) {
      setIsCreating(false);
    }
  }, [status, isCreating]);

  if (!projectId) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-8', className)}>
        <div className="text-center space-y-4">
          <Monitor className="h-12 w-12 mx-auto text-muted-foreground" />
          <div>
            <h3 className="text-lg font-semibold">No Project</h3>
            <p className="text-sm text-muted-foreground mt-1">
              A project is required to access the computer
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full p-8', className)}>
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground mt-4">Checking status...</p>
      </div>
    );
  }

  const isStarting = status === 'STARTING' || isCreating;
  const isFailed = status === 'FAILED';
  const canStart = !isStarting && !startSandbox.isPending;

  const handleStart = async () => {
    if (!projectId || startSandbox.isPending) return;
    try {
      setIsCreating(true);
      await startSandbox.mutateAsync(projectId);
      // Keep showing "creating" state until status updates via polling
    } catch (error) {
      console.error('Failed to start sandbox:', error);
      setIsCreating(false);
    }
  };

  return (
    <div className={cn('flex flex-col items-center justify-center h-full p-8', className)}>
      <div className="text-center space-y-6 max-w-md">
        {/* Icon */}
        <div className="flex justify-center">
          {isStarting ? (
            <div className="relative">
              <Monitor className="h-16 w-16 text-muted-foreground" />
              <div className="absolute -bottom-1 -right-1 bg-background rounded-full p-1">
                <Loader2 className="h-5 w-5 animate-spin text-chart-3" />
              </div>
            </div>
          ) : isFailed ? (
            <div className="relative">
              <Monitor className="h-16 w-16 text-muted-foreground" />
              <div className="absolute -bottom-1 -right-1 bg-background rounded-full p-1">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
            </div>
          ) : (
            <Monitor className="h-16 w-16 text-muted-foreground" />
          )}
        </div>

        {/* Text */}
        <div className="space-y-2">
          <h3 className="text-xl font-semibold">
            {isStarting ? 'Starting Computer...' : isFailed ? 'Failed to Start' : 'Computer Not Running'}
          </h3>
          <p className="text-sm text-muted-foreground">
            {isStarting 
              ? 'This may take up to a minute.'
              : isFailed 
                ? 'Something went wrong. Please try again.'
                : 'Start the computer to browse and manage files.'}
          </p>
        </div>

        {/* Start Button - only show when not starting */}
        {canStart && (
          <div className="pt-2">
            <Button
              onClick={handleStart}
              disabled={startSandbox.isPending}
              size="lg"
              className="min-w-[180px]"
            >
              <Power className="h-4 w-4 mr-2" />
              Start Computer
            </Button>
          </div>
        )}

        {/* Starting indicator */}
        {isStarting && (
          <div className="pt-2">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-chart-3/10 text-chart-3 border border-chart-3/20 text-sm font-medium">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Starting up...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
