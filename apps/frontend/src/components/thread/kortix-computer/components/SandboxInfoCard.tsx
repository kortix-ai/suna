'use client';

import { memo } from 'react';
import { motion } from 'framer-motion';
import { Cpu, HardDrive, MemoryStick, MapPin, AlertTriangle, Loader2 } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import type { SandboxState, SandboxStatus, SandboxDetails } from '@/hooks/files/use-sandbox-details';
import { getSandboxStatusLabel } from '@/hooks/files/use-sandbox-details';
import { Card } from '@/components/ui/card';

// Support both new SandboxState and legacy SandboxDetails
type SandboxData = SandboxState | SandboxDetails | null | undefined;

interface SandboxInfoCardProps {
  sandboxDetails?: SandboxDetails | null;
  sandboxStatus?: SandboxState | null;
  isLoading: boolean;
}

/**
 * Get status from either new SandboxState or legacy SandboxDetails
 */
function getStatus(data: SandboxData): SandboxStatus {
  if (!data) return 'UNKNOWN';

  // New SandboxState has 'status' field
  if ('status' in data && data.status) {
    return data.status as SandboxStatus;
  }

  // Legacy SandboxDetails has 'state' field - map to new status
  if ('state' in data && data.state) {
    const state = data.state.toLowerCase();
    if (state === 'started' || state === 'running') return 'LIVE';
    if (state === 'stopped' || state === 'archived') return 'OFFLINE';
    if (state === 'archiving') return 'STARTING';
  }

  return 'UNKNOWN';
}

/**
 * Get color class for status
 */
function getStatusColor(status: SandboxStatus): string {
  switch (status) {
    case 'LIVE':
      return 'text-chart-2'; // Green
    case 'STARTING':
      return 'text-chart-3'; // Yellow/amber
    case 'OFFLINE':
      return 'text-muted-foreground';
    case 'FAILED':
      return 'text-destructive';
    case 'UNKNOWN':
    default:
      return 'text-muted-foreground';
  }
}

/**
 * Status indicator with appropriate animation
 */
function StatusIndicator({ status }: { status: SandboxStatus }) {
  switch (status) {
    case 'LIVE':
      return (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-2 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-chart-2" />
        </span>
      );

    case 'STARTING':
      return <Loader2 className="h-3 w-3 animate-spin text-chart-3" />;

    case 'FAILED':
      return <AlertTriangle className="h-3 w-3 text-destructive" />;

    case 'OFFLINE':
      return <span className="h-2 w-2 rounded-full bg-muted-foreground" />;

    case 'UNKNOWN':
    default:
      return <span className="h-2 w-2 rounded-full bg-muted-foreground opacity-50" />;
  }
}

/**
 * Get helper text for current status
 */
function getStatusHelperText(status: SandboxStatus): string {
  switch (status) {
    case 'LIVE':
      return 'Click on dock items to open windows';
    case 'STARTING':
      return 'Sandbox is starting up...';
    case 'OFFLINE':
      return 'Sandbox is offline';
    case 'FAILED':
      return 'Sandbox services are unavailable';
    case 'UNKNOWN':
    default:
      return 'Checking sandbox status...';
  }
}

export const SandboxInfoCard = memo(function SandboxInfoCard({
  sandboxDetails,
  sandboxStatus,
  isLoading,
}: SandboxInfoCardProps) {
  // Use sandboxStatus if provided, otherwise fall back to sandboxDetails
  const data: SandboxData = sandboxStatus || sandboxDetails;
  const status = getStatus(data);

  if (isLoading) {
    return (
      <motion.div
        initial={{ opacity: 1, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30, opacity: { duration: 0.15 } }}
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
      >
        <Card variant="glass" className="p-8 rounded-3xl gap-0">
          <KortixLoader size="medium" />
        </Card>
      </motion.div>
    );
  }

  if (!data) return null;

  // Extract error from SandboxState if available
  const error = sandboxStatus?.error;

  return (
    <motion.div
      initial={{ opacity: 1, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30, opacity: { duration: 0.15 } }}
      className="absolute -top-30 inset-0 flex items-center justify-center pointer-events-none"
    >
      <Card variant="glass" className="p-6 min-w-[320px] max-w-[380px] rounded-3xl gap-0">
        {/* Header with logo and status */}
        <div className="flex flex-col items-center justify-center gap-3 mb-5">
          <div className="w-16 h-16 rounded-3xl bg-background flex items-center justify-center border mx-auto">
            <KortixLogo size={32} />
          </div>
          <div className="flex flex-col items-center justify-center">
            <h3 className="text-foreground font-semibold text-lg text-center">Kortix Computer</h3>
            <div className="flex items-center justify-center gap-2 mt-0.5">
              <StatusIndicator status={status} />
              <span className={cn("text-xs font-medium", getStatusColor(status))}>
                {getSandboxStatusLabel(status)}
              </span>
            </div>
          </div>
        </div>

        {/* Error message for failed state */}
        {status === 'FAILED' && error && (
          <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {/* Resource metrics */}
        <div className="grid grid-cols-3 gap-2.5 mb-4">
          <div className="bg-muted/50 rounded-xl p-3 border border-border">
            <div className="flex items-center gap-1.5 mb-1">
              <Cpu className="w-3.5 h-3.5" />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">CPU</span>
            </div>
            <p className="text-foreground font-semibold text-lg leading-tight">{data.cpu || 1}</p>
            <p className="text-[10px] text-muted-foreground/70">cores</p>
          </div>

          <div className="bg-muted/50 rounded-xl p-3 border border-border">
            <div className="flex items-center gap-1.5 mb-1">
              <MemoryStick className="w-3.5 h-3.5" />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">RAM</span>
            </div>
            <p className="text-foreground font-semibold text-lg leading-tight">{data.memory || 1}</p>
            <p className="text-[10px] text-muted-foreground/70">GB</p>
          </div>

          <div className="bg-muted/50 rounded-xl p-3 border border-border">
            <div className="flex items-center gap-1.5 mb-1">
              <HardDrive className="w-3.5 h-3.5" />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Disk</span>
            </div>
            <p className="text-foreground font-semibold text-lg leading-tight">{data.disk || 3}</p>
            <p className="text-[10px] text-muted-foreground/70">GB</p>
          </div>
        </div>

        {/* Region info */}
        {data.target && (
          <div className="flex items-center px-3 py-2 bg-muted/50 rounded-lg border border-border">
            <MapPin className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs text-muted-foreground">Region:</span>
            <span className="text-xs text-foreground font-medium uppercase ml-1">{data.target}</span>
          </div>
        )}

        {/* Status helper text */}
        <p className="text-[10px] text-muted-foreground text-center mt-4">
          {getStatusHelperText(status)}
        </p>
      </Card>
    </motion.div>
  );
});

SandboxInfoCard.displayName = 'SandboxInfoCard';
