'use client';

import { memo, useState, useEffect } from 'react';
import { Minimize2, Wifi, BatteryLow, BatteryMedium, BatteryFull, BatteryCharging, Library, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DrawerTitle } from '@/components/ui/drawer';
import { ViewType } from '@/stores/kortix-computer-store';
import { cn } from '@/lib/utils';
import { ViewToggle } from './ViewToggle';
import { ToolbarButtons } from './ToolbarButtons';
import Image from 'next/image';
import { motion } from 'framer-motion';

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

function StatusBar() {
  const batteryInfo = useBatteryStatus();
  const currentTime = useCurrentTime();

  return (
    <div className="flex items-center gap-2 text-[11px]">
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
  
  // Responsive sizing
  const containerPadding = size === 'sm' ? 'p-1' : 'p-1';
  const buttonPadding = size === 'sm' ? 'px-3 py-1.5' : 'px-4 py-2';
  const fontSize = size === 'sm' ? 'text-[11px]' : 'text-xs';
  const iconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const indicatorHeight = size === 'sm' ? 'h-7' : 'h-8';
  const gap = size === 'sm' ? 'gap-1.5' : 'gap-2';

  return (
    <div className={cn(
      "relative flex items-center bg-muted rounded-2xl",
      containerPadding
    )}>
      {/* Sliding indicator */}
      <motion.div
        className={cn(
          "absolute top-1 bg-white dark:bg-zinc-700 rounded-xl shadow-sm",
          indicatorHeight
        )}
        style={{
          left: 4,
          width: 'calc(50% - 4px)',
        }}
        initial={false}
        animate={{
          x: isAction ? 0 : 'calc(100% + 0px)',
        }}
        transition={{
          type: "spring",
          stiffness: 400,
          damping: 30
        }}
      />
      
      <button
        onClick={() => onViewChange('tools')}
        className={cn(
          "relative z-10 flex items-center justify-center rounded-xl font-medium transition-colors duration-150 flex-1",
          buttonPadding,
          fontSize,
          gap,
          isAction
            ? "text-zinc-900 dark:text-white"
            : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
        )}
      >
        <Zap className={cn(iconSize, isAction && "fill-current")} />
        <span>Action</span>
      </button>
      
      <button
        onClick={() => onViewChange('files')}
        className={cn(
          "relative z-10 flex items-center justify-center rounded-xl font-medium transition-colors duration-150 flex-1",
          buttonPadding,
          fontSize,
          gap,
          isFiles
            ? "text-zinc-900 dark:text-white"
            : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
        )}
      >
        <Library className={cn(iconSize)} />
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
}: PanelHeaderProps) {
  if (variant === 'drawer') {
    return (
      <div className="h-14 flex-shrink-0 px-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center">
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
          <DrawerTitle className="sr-only">Kortix Computer</DrawerTitle>
        </div>
        <div className="flex items-center gap-2">
          <ActionFilesSwitcher 
            currentView={currentView} 
            onViewChange={onViewChange} 
            size="sm"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
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
        <ActionFilesSwitcher 
          currentView={currentView} 
          onViewChange={onViewChange} 
          size={isMaximized ? 'sm' : 'md'}
        />
        {isMaximized && (
          <>
            <StatusBar />
          </>
        )}
      </div>
    </div>
  );
});

PanelHeader.displayName = 'PanelHeader';

