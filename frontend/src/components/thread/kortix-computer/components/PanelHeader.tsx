'use client';

import { memo, useState, useEffect } from 'react';
import { CircleDashed, Minimize2, Maximize2, Wifi, Battery, BatteryLow, BatteryMedium, BatteryFull, BatteryCharging } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DrawerTitle } from '@/components/ui/drawer';
import { ViewType } from '@/stores/kortix-computer-store';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import { ViewToggle } from './ViewToggle';
import { ToolbarButtons } from './ToolbarButtons';

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
  const title = "Kortix Computer";

  if (variant === 'drawer') {
    return (
      <div className="h-14 flex-shrink-0 px-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 flex items-center justify-center">
            <KortixLogo size={18}/>
          </div>
          <DrawerTitle className="text-sm font-semibold text-foreground">
            {title}
          </DrawerTitle>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle currentView={currentView} onViewChange={onViewChange} showFilesTab={showFilesTab} />
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
        className="flex items-center justify-center gap-1.5 cursor-pointer select-none hover:opacity-80 transition-opacity"
      >
        <div className="w-5 h-5 flex items-center justify-center">
          <KortixLogo size={14}/>
        </div>
        <h2 className="text-sm font-semibold text-foreground">
          {title}
        </h2>
      </div>
      
      <div className="flex items-center justify-end gap-2">
        {isStreaming && (
          <div className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-primary/10 text-primary flex items-center gap-1">
            <CircleDashed className="h-2.5 w-2.5 animate-spin" />
            <span>Running</span>
          </div>
        )}
        {!hideViewToggle && (
          <ViewToggle currentView={currentView} onViewChange={onViewChange} showFilesTab={showFilesTab} />
        )}
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

