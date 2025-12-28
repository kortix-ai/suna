import { Cloud, CloudOff, Check, AlertCircle, RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline' | 'conflict';

interface SyncStatusIndicatorProps {
  status: SyncStatus;
  lastSyncedAt: number | null;
  pendingChanges: boolean;
  errorMessage?: string;
  onRefresh?: () => void;
  onResolveConflict?: (keepLocal: boolean) => void;
  className?: string;
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function SyncStatusIndicator({
  status,
  lastSyncedAt,
  pendingChanges,
  errorMessage,
  onRefresh,
  onResolveConflict,
  className,
}: SyncStatusIndicatorProps) {
  const getStatusConfig = () => {
    switch (status) {
      case 'syncing':
        return {
          icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
          label: 'Saving...',
          color: 'text-blue-500',
          bgColor: 'bg-blue-500/10',
        };
      case 'synced':
        return {
          icon: <Check className="w-3.5 h-3.5" />,
          label: lastSyncedAt ? `Saved ${formatRelativeTime(lastSyncedAt)}` : 'Saved',
          color: 'text-green-500',
          bgColor: 'bg-green-500/10',
        };
      case 'offline':
        return {
          icon: <CloudOff className="w-3.5 h-3.5" />,
          label: pendingChanges ? 'Offline - changes pending' : 'Offline',
          color: 'text-amber-500',
          bgColor: 'bg-amber-500/10',
        };
      case 'error':
        return {
          icon: <AlertCircle className="w-3.5 h-3.5" />,
          label: errorMessage || 'Save failed',
          color: 'text-red-500',
          bgColor: 'bg-red-500/10',
        };
      case 'conflict':
        return {
          icon: <AlertCircle className="w-3.5 h-3.5" />,
          label: 'External changes detected',
          color: 'text-orange-500',
          bgColor: 'bg-orange-500/10',
        };
      default:
        return {
          icon: <Cloud className="w-3.5 h-3.5" />,
          label: 'Ready',
          color: 'text-zinc-400',
          bgColor: 'bg-zinc-500/10',
        };
    }
  };

  const config = getStatusConfig();

  if (status === 'conflict') {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <div className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all duration-200',
          config.bgColor,
          config.color
        )}>
          {config.icon}
          <span>{config.label}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onResolveConflict?.(false)}
            className="h-6 px-2 text-xs"
          >
            Load External
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onResolveConflict?.(true)}
            className="h-6 px-2 text-xs"
          >
            Keep Mine
          </Button>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <div className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all duration-200 cursor-default',
            config.bgColor,
            config.color,
            className
          )}>
            {config.icon}
            {(status === 'syncing' || status === 'error' || status === 'offline') && (
              <span className="hidden sm:inline">{config.label}</span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div className="flex flex-col gap-1">
            <span>{config.label}</span>
            {pendingChanges && status !== 'syncing' && (
              <span className="text-amber-400">Unsaved changes</span>
            )}
            {status === 'error' && onRefresh && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onRefresh}
                className="h-6 px-2 text-xs mt-1"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Retry
              </Button>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
