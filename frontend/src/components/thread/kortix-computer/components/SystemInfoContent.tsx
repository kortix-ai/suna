'use client';

import { memo } from 'react';
import { Cpu, HardDrive, MemoryStick, MapPin, Loader2 } from 'lucide-react';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import { SandboxDetails } from '@/hooks/files/use-sandbox-details';

interface SystemInfoContentProps {
  sandboxDetails: SandboxDetails | null | undefined;
  isLoading: boolean;
}

const getStateColor = (state: string) => {
  switch (state?.toLowerCase()) {
    case 'started':
    case 'running':
      return 'text-chart-2';
    case 'stopped':
      return 'text-chart-4';
    case 'archived':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
};

const StateIndicator = ({ state }: { state: string }) => {
  const isActive = state?.toLowerCase() === 'started' || state?.toLowerCase() === 'running';
  
  if (isActive) {
    return (
      <span className="relative flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-2 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-chart-2" />
      </span>
    );
  }
  
  if (state?.toLowerCase() === 'stopped') {
    return <span className="h-2.5 w-2.5 rounded-full bg-chart-4" />;
  }
  
  return <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />;
};

export const SystemInfoContent = memo(function SystemInfoContent({
  sandboxDetails,
  isLoading,
}: SystemInfoContentProps) {
  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (!sandboxDetails) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        No sandbox information available
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex flex-col items-center justify-center gap-4 mb-8">
        <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-background to-muted flex items-center justify-center border shadow-lg">
          <KortixLogo size={40} />
        </div>
        <div className="flex flex-col items-center justify-center">
          <h3 className="text-foreground font-semibold text-xl text-center">Kortix Computer</h3>
          <div className="flex items-center justify-center gap-2 mt-1">
            <StateIndicator state={sandboxDetails.state} />
            <span className={cn("text-sm font-medium capitalize", getStateColor(sandboxDetails.state))}>
              {sandboxDetails.state}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-muted/50 rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
              <Cpu className="w-4 h-4 text-white" />
            </div>
            <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">CPU</span>
          </div>
          <p className="text-foreground font-bold text-2xl leading-tight">{sandboxDetails.cpu || 1}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5">cores</p>
        </div>

        <div className="bg-muted/50 rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center">
              <MemoryStick className="w-4 h-4 text-white" />
            </div>
            <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">RAM</span>
          </div>
          <p className="text-foreground font-bold text-2xl leading-tight">{sandboxDetails.memory || 1}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5">GB</p>
        </div>

        <div className="bg-muted/50 rounded-xl p-4 border border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center">
              <HardDrive className="w-4 h-4 text-white" />
            </div>
            <span className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Disk</span>
          </div>
          <p className="text-foreground font-bold text-2xl leading-tight">{sandboxDetails.disk || 3}</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5">GB</p>
        </div>
      </div>

      {sandboxDetails.target && (
        <div className="flex items-center px-4 py-3 bg-muted/50 rounded-xl border border-border">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center mr-3">
            <MapPin className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="text-xs text-muted-foreground block">Region</span>
            <span className="text-sm text-foreground font-semibold uppercase">{sandboxDetails.target}</span>
          </div>
        </div>
      )}
    </div>
  );
});

SystemInfoContent.displayName = 'SystemInfoContent';

