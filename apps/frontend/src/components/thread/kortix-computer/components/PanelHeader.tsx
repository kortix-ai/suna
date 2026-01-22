'use client';

import { memo, useState, useEffect } from 'react';
import { Minimize2, Wifi, BatteryLow, BatteryMedium, BatteryFull, BatteryCharging, FolderOpen, Activity, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DrawerTitle } from '@/components/ui/drawer';
import { ViewType } from '@/stores/kortix-computer-store';
import { cn } from '@/lib/utils';
import { ViewToggle } from './ViewToggle';
import { ToolbarButtons } from './ToolbarButtons';
import Image from 'next/image';
import { motion } from 'framer-motion';
import type { SandboxStatus } from '@/hooks/files/use-sandbox-details';

function useBatteryStatus() {
  const [batteryInfo, setBatteryInfo] = useState<{ level: number; charging: boolean } | null>(null);

  useEffect(() => {
    let battery: any = null;

    const updateBatteryInfo = (b: any) => {
      setBatteryInfo({
        level: Math.round(b.level * 100),
        charging: b.charging,
      });
    };

    const setupBattery = async () => {
      try {
        if ('getBattery' in navigator) {
          battery = await (navigator as any).getBattery();
          updateBatteryInfo(battery);

          battery.addEventListener('levelchange', () => updateBatteryInfo(battery));
          battery.addEventListener('chargingchange', () => updateBatteryInfo(battery));
        }
      } catch (e) {
        console.log('Battery API not available');
      }
    };

    setupBattery();

    return () => {
      if (battery) {
        battery.removeEventListener('levelchange', () => updateBatteryInfo(battery));
        battery.removeEventListener('chargingchange', () => updateBatteryInfo(battery));
      }
    };
  }, []);

  return batteryInfo;
}

function useCurrentTime() {
  const [time, setTime] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTime(now.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }));
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return time;
}

function BatteryIcon({ level, charging }: { level: number; charging: boolean }) {
  if (charging) return <BatteryCharging className="h-4.5 w-4.5" />;
  if (level <= 20) return <BatteryLow className="h-4.5 w-4.5" />;
  if (level <= 50) return <BatteryMedium className="h-4.5 w-4.5" />;
  return <BatteryFull className="h-4.5 w-4.5" />;
}

function SandboxStatusIndicator({ status }: { status?: SandboxStatus }) {
  if (!status) return null;

  switch (status) {
    case 'LIVE':
      // Solid green dot
      return (
        <span className="h-2 w-2 rounded-full bg-green-500" title="Live" />
      );
    case 'STARTING':
      // Flashing/pulsing green dot
      return (
        <span className="relative flex h-2 w-2" title="Starting">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
      );
    case 'FAILED':
      // Red dot
      return (
        <span className="h-2 w-2 rounded-full bg-red-500" title="Services unhealthy" />
      );
    case 'OFFLINE':
      // Gray dot
      return (
        <span className="h-2 w-2 rounded-full bg-gray-400" title="Offline" />
      );
    case 'UNKNOWN':
      // Pulsing gray/yellow dot - sandbox may not exist yet or is being created
      return (
        <span className="relative flex h-2 w-2" title="Initializing">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-50" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500" />
        </span>
      );
    default:
      return null;
  }
}

function StatusBar({ sandboxStatus }: { sandboxStatus?: SandboxStatus }) {
  const batteryInfo = useBatteryStatus();
  const currentTime = useCurrentTime();

  return (
    <div className="flex items-center gap-3 text-[11px]">
      <SandboxStatusIndicator status={sandboxStatus} />
      <div className="flex items-center gap-1">
        <Wifi className="h-3.5 w-3.5" />
      </div>
      <div className="font-medium">
        {currentTime}
      </div>
    </div>
  );
}

interface ActionFilesSwitcherProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  size?: 'sm' | 'md';
}

function ActionFilesSwitcher({ currentView, onViewChange, size = 'md' }: ActionFilesSwitcherProps) {
  const isAction = currentView === 'tools';
  const isFiles = currentView === 'files';

  // Size variants - sm is more compact for mobile
  const config = size === 'sm'
    ? { height: 30, padding: 2, btnWidth: 64, iconSize: 12, fontSize: 11 }
    : { height: 36, padding: 3, btnWidth: 80, iconSize: 14, fontSize: 12 };

  const totalWidth = config.btnWidth * 2 + config.padding * 2;

  return (
    <div
      className="relative flex items-center bg-zinc-100 dark:bg-zinc-800/90 rounded-full"
      style={{
        height: config.height,
        width: totalWidth,
        padding: config.padding
      }}
    >
      {/* Sliding indicator */}
      <motion.div
        className="absolute top-[3px] bottom-[3px] rounded-full bg-white dark:bg-zinc-900 shadow-sm"
        style={{ width: config.btnWidth }}
        initial={false}
        animate={{ x: isAction ? 0 : config.btnWidth }}
        transition={{ type: "spring", stiffness: 500, damping: 35 }}
      />

      {/* Actions button */}
      <button
        onClick={() => onViewChange('tools')}
        className={cn(
          "relative z-10 flex items-center justify-center gap-1.5 rounded-full font-medium transition-colors cursor-pointer",
          isAction ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500"
        )}
        style={{ width: config.btnWidth, height: config.height - config.padding * 2, fontSize: config.fontSize }}
      >
        <Activity style={{ width: config.iconSize, height: config.iconSize }} strokeWidth={2.5} />
        <span>Actions</span>
      </button>

      {/* Files button */}
      <button
        onClick={() => onViewChange('files')}
        className={cn(
          "relative z-10 flex items-center justify-center gap-1.5 rounded-full font-medium transition-colors cursor-pointer",
          isFiles ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500"
        )}
        style={{ width: config.btnWidth, height: config.height - config.padding * 2, fontSize: config.fontSize }}
      >
        <FolderOpen style={{ width: config.iconSize, height: config.iconSize }} strokeWidth={2.5} />
        <span>Files</span>
      </button>
    </div>
  );
}

interface PanelHeaderProps {
  agentName?: string;
  onClose: () => void;
  onMaximize?: () => void;
  isStreaming?: boolean;
  variant?: 'drawer' | 'desktop' | 'motion';
  layoutId?: string;
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  showFilesTab?: boolean;
  isMaximized?: boolean;
  isSuiteMode?: boolean;
  onToggleSuiteMode?: () => void;
  hideViewToggle?: boolean;
  sandboxStatus?: SandboxStatus;
}

export const PanelHeader = memo(function PanelHeader({
  agentName,
  onClose,
  onMaximize,
  isStreaming = false,
  variant = 'desktop',
  layoutId,
  currentView,
  onViewChange,
  showFilesTab = true,
  isMaximized = false,
  isSuiteMode = false,
  onToggleSuiteMode,
  hideViewToggle = false,
  sandboxStatus,
}: PanelHeaderProps) {
  if (variant === 'drawer') {
    return (
      <div className="h-12 flex-shrink-0 px-3 flex items-center justify-between border-b border-border bg-background/95 backdrop-blur-sm">
        {/* Left: Logo - compact for mobile */}
        <div className="flex items-center min-w-0">
          <Image
            src="/kortix-computer-white.svg"
            alt="Kortix Computer"
            width={120}
            height={14}
            className="hidden dark:block"
            priority
          />
          <Image
            src="/kortix-computer-black.svg"
            alt="Kortix Computer"
            width={120}
            height={14}
            className="block dark:hidden"
            priority
          />
          <DrawerTitle className="sr-only">Kortix Computer</DrawerTitle>
        </div>
        
        {/* Right: Switcher + Close - tighter spacing */}
        <div className="flex items-center gap-1.5">
          <ActionFilesSwitcher
            currentView={currentView}
            onViewChange={onViewChange}
            size="sm"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 text-muted-foreground hover:text-foreground touch-manipulation"
            title="Minimize"
          >
            <Minimize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex-shrink-0 grid grid-cols-3 items-center",
      isMaximized
        ? "h-9 px-3"
        : "h-14 px-3.5 pt-1 border-b border-border"
    )}>
      <div className="flex items-center justify-start">
        <ToolbarButtons
          onClose={onClose}
          isMaximized={isMaximized}
        />
      </div>
      <div
        onClick={() => onMaximize?.()}
        className="flex items-center justify-center cursor-pointer select-none hover:opacity-80 transition-opacity"
      >
        <Image
          src="/kortix-computer-white.svg"
          alt="Kortix Computer"
          width={140}
          height={16}
          className="hidden dark:block"
          priority
        />
        <Image
          src="/kortix-computer-black.svg"
          alt="Kortix Computer"
          width={140}
          height={16}
          className="block dark:hidden"
          priority
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        {/* Show sandbox status indicator when not maximized */}
        {/* {!isMaximized && <SandboxStatusIndicator status={sandboxStatus} />} */}
        <ActionFilesSwitcher
          currentView={currentView}
          onViewChange={onViewChange}
          size={isMaximized ? 'sm' : 'md'}
        />
        {isMaximized && <StatusBar sandboxStatus={sandboxStatus} />}
      </div>
    </div>
  );
});

PanelHeader.displayName = 'PanelHeader';

