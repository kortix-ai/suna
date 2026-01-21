'use client';

import { memo } from 'react';
import { Cpu, HardDrive, MemoryStick, MapPin, AlertTriangle, Loader2 } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import type { SandboxDetails, SandboxState, SandboxStatus } from '@/hooks/files/use-sandbox-details';
import { getSandboxStatusLabel } from '@/hooks/files/use-sandbox-details';

interface SystemInfoContentProps {
  sandboxDetails: SandboxDetails | null | undefined;
  sandboxStatus?: SandboxState | null;
  isLoading: boolean;
}

/**
 * Get status from either new SandboxState or legacy SandboxDetails
 */
function getStatus(sandboxStatus?: SandboxState | null, sandboxDetails?: SandboxDetails | null): SandboxStatus {
  // Prefer new status if available
  if (sandboxStatus?.status) {
    return sandboxStatus.status;
  }

  // Fall back to legacy state mapping
  if (sandboxDetails?.state) {
    const state = sandboxDetails.state.toLowerCase();
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
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-2 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-chart-2" />
        </span>
      );

    case 'STARTING':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-chart-3" />;

    case 'FAILED':
      return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;

    case 'OFFLINE':
      return <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />;

    case 'UNKNOWN':
    default:
      return <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground opacity-50" />;
  }
}

export const SystemInfoContent = memo(function SystemInfoContent({
  sandboxDetails,
  sandboxStatus,
  isLoading,
}: SystemInfoContentProps) {
  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <KortixLoader size="medium" />
      </div>
    );
  }

  // Use data from either source
  const data = sandboxStatus || sandboxDetails;

  if (!data) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No sandbox information available
      </div>
    );
  }

  const status = getStatus(sandboxStatus, sandboxDetails);
  const error = sandboxStatus?.error;

  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex flex-col items-center justify-center gap-4 mb-8">
        <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-background to-muted flex items-center justify-center border shadow-lg">
          <KortixLogo size={40} />
        </div>
        <div className="flex flex-col items-center justify-center">
          <h3 className="text-foreground font-semibold text-xl text-center">Kortix Computer</h3>
          <div className="flex items-center justify-center gap-2 mt-1">
            <StatusIndicator status={status} />
            <span className={cn("text-sm font-medium", getStatusColor(status))}>
              {getSandboxStatusLabel(status)}
            </span>
          </div>
        </div>
      </div>

      {/* Error message for failed state */}
      {status === 'FAILED' && error && (
        <div className="mb-6 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {/* Services health info (when available) */}
      {sandboxStatus?.services_health && (
        <div className="mb-6 p-4 bg-muted/50 rounded-xl border border-border">
          <h4 className="text-xs text-muted-foreground uppercase tracking-wide font-medium mb-3">Services</h4>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(sandboxStatus.services_health.services).map(([service, serviceStatus]) => (
              <div key={service} className="flex items-center gap-2">
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  serviceStatus === 'running' ? 'bg-chart-2' :
                  serviceStatus === 'starting' ? 'bg-chart-3' :
                  'bg-destructive'
                )} />
                <span className="text-xs text-muted-foreground">{service}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-muted/50 rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
              <Cpu className="w-4 h-4 text-white" />
            </div>
            <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">CPU</span>
          </div>
          <p className="text-foreground font-bold text-2xl leading-tight">{data.cpu || 1}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5">cores</p>
        </div>

        <div className="bg-muted/50 rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-zinc-500 to-zinc-600 flex items-center justify-center">
              <MemoryStick className="w-4 h-4 text-white" />
            </div>
            <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">RAM</span>
          </div>
          <p className="text-foreground font-bold text-2xl leading-tight">{data.memory || 1}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5">GB</p>
        </div>

        <div className="bg-muted/50 rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center">
              <HardDrive className="w-4 h-4 text-white" />
            </div>
            <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Disk</span>
          </div>
          <p className="text-foreground font-bold text-2xl leading-tight">{data.disk || 3}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5">GB</p>
        </div>
      </div>

      {data.target && (
        <div className="flex items-center px-4 py-3 bg-muted/50 rounded-xl border border-border">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center mr-3">
            <MapPin className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="text-xs text-muted-foreground block">Region</span>
            <span className="text-sm text-foreground font-semibold uppercase">{data.target}</span>
          </div>
        </div>
      )}
    </div>
  );
});

SystemInfoContent.displayName = 'SystemInfoContent';
