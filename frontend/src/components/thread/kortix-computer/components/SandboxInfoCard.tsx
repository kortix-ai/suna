'use client';

import { memo } from 'react';
import { motion } from 'framer-motion';
import { Cpu, HardDrive, MemoryStick, MapPin, Loader2 } from 'lucide-react';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import { SandboxDetails } from '@/hooks/files/use-sandbox-details';
import { Card } from '@/components/ui/card';

interface SandboxInfoCardProps {
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
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-chart-2 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-chart-2" />
      </span>
    );
  }
  
  if (state?.toLowerCase() === 'stopped') {
    return <span className="h-2 w-2 rounded-full bg-chart-4" />;
  }
  
  return <span className="h-2 w-2 rounded-full bg-muted-foreground" />;
};

export const SandboxInfoCard = memo(function SandboxInfoCard({
  sandboxDetails,
  isLoading,
}: SandboxInfoCardProps) {
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
          <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
        </Card>
      </motion.div>
    );
  }

  if (!sandboxDetails) return null;

  return (
    <motion.div
      initial={{ opacity: 1, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30, opacity: { duration: 0.15 } }}
      className="absolute -top-30 inset-0 flex items-center justify-center pointer-events-none"
    >
      <Card variant="glass" className="p-6 min-w-[320px] max-w-[380px] rounded-3xl gap-0">
        <div className="flex flex-col items-center justify-center gap-3 mb-5">
          <div className="w-16 h-16 rounded-3xl bg-background flex items-center justify-center border mx-auto">
            <KortixLogo size={32} />
          </div>
          <div className="flex flex-col items-center justify-center">
            <h3 className="text-foreground font-semibold text-lg text-center">Kortix Computer</h3>
            <div className="flex items-center justify-center gap-2 mt-0.5">
              <StateIndicator state={sandboxDetails.state} />
              <span className={cn("text-xs font-medium capitalize", getStateColor(sandboxDetails.state))}>
                {sandboxDetails.state}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 mb-4">
          <div className="bg-muted/50 rounded-xl p-3 border border-border">
            <div className="flex items-center gap-1.5 mb-1">
              <Cpu className="w-3.5 h-3.5" />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">CPU</span>
            </div>
            <p className="text-foreground font-semibold text-lg leading-tight">{sandboxDetails.cpu || 1}</p>
            <p className="text-[10px] text-muted-foreground/70">cores</p>
          </div>

          <div className="bg-muted/50 rounded-xl p-3 border border-border">
            <div className="flex items-center gap-1.5 mb-1">
              <MemoryStick className="w-3.5 h-3.5" />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">RAM</span>
            </div>
            <p className="text-foreground font-semibold text-lg leading-tight">{sandboxDetails.memory || 1}</p>
            <p className="text-[10px] text-muted-foreground/70">GB</p>
          </div>

          <div className="bg-muted/50 rounded-xl p-3 border border-border">
            <div className="flex items-center gap-1.5 mb-1">
              <HardDrive className="w-3.5 h-3.5" />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Disk</span>
            </div>
            <p className="text-foreground font-semibold text-lg leading-tight">{sandboxDetails.disk || 3}</p>
            <p className="text-[10px] text-muted-foreground/70">GB</p>
          </div>
        </div>

        {sandboxDetails.target && (
          <div className="flex items-center px-3 py-2 bg-muted/50 rounded-lg border border-border">
            <MapPin className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs text-muted-foreground">Region:</span>
            <span className="text-xs text-foreground font-medium uppercase">{sandboxDetails.target}</span>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground text-center mt-4">
          Click on dock items to open windows
        </p>
      </Card>
    </motion.div>
  );
});

SandboxInfoCard.displayName = 'SandboxInfoCard';
