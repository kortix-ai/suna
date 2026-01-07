'use client';

import { memo, useState, useEffect } from 'react';
import { Minimize2, Maximize2, Wifi, Battery, BatteryLow, BatteryMedium, BatteryFull, BatteryCharging, CheckCircle, Loader2, XCircle, ArrowLeft, GitBranch } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Button } from '@/components/ui/button';
import { DrawerTitle } from '@/components/ui/drawer';
import { ViewType } from '@/stores/kortix-computer-store';
import { cn } from '@/lib/utils';
import { ViewToggle } from './ViewToggle';
import { ToolbarButtons } from './ToolbarButtons';
import Image from 'next/image';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';

export interface SubAgentInfo {
  thread_id: string;
  task?: string;
  status?: string;
}

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
  // Sub-agent support
  subAgents?: SubAgentInfo[];
  selectedSubAgentId?: string | null;
  onSubAgentSelect?: (threadId: string | null) => void;
  isSubAgentView?: boolean;
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
  subAgents = [],
  selectedSubAgentId,
  onSubAgentSelect,
  isSubAgentView = false,
}: PanelHeaderProps) {
  const hasSubAgents = subAgents.length > 0;
  const runningCount = subAgents.filter(a => a.status === 'running' || a.status === 'pending').length;
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
        {isStreaming && (
          <div className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-primary/10 text-primary flex items-center gap-1">
            <KortixLoader size="small" />
            <span>Running</span>
          </div>
        )}

        {/* Sub-agent toggle - styled like ViewToggle */}
        {hasSubAgents && onSubAgentSelect && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <div className="relative flex items-center bg-muted rounded-3xl px-1 py-1 cursor-pointer">
                <button className="relative z-10 h-7 w-7 p-0 rounded-xl flex items-center justify-center bg-transparent hover:bg-white/50 dark:hover:bg-zinc-700/50 transition-colors">
                  <GitBranch className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
                </button>
                {runningCount > 0 && (
                  <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse z-20" />
                )}
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Sub-Agents
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <div className="max-h-64 overflow-y-auto">
                {/* Main Thread - first option when viewing a sub-agent */}
                {selectedSubAgentId && (
                  <DropdownMenuItem
                    onClick={() => onSubAgentSelect(null)}
                    className="flex items-center gap-2 py-2 cursor-pointer"
                  >
                    <span className="text-sm truncate flex-1">Main Thread</span>
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0 bg-primary/10 text-primary">
                      main
                    </Badge>
                  </DropdownMenuItem>
                )}

                {/* Sub-agents list */}
                {subAgents.map(agent => {
                  const displayTask = agent.task
                    ? (agent.task.length > 45 ? agent.task.slice(0, 45) + '...' : agent.task)
                    : 'Sub-agent';
                  const isSelected = agent.thread_id === selectedSubAgentId;

                  return (
                    <DropdownMenuItem
                      key={agent.thread_id}
                      onClick={() => onSubAgentSelect(agent.thread_id)}
                      className={cn(
                        "flex items-center gap-2 py-2 cursor-pointer",
                        isSelected && "bg-accent"
                      )}
                    >
                      <span className="text-sm truncate flex-1">{displayTask}</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] h-4 px-1.5 shrink-0",
                          agent.status === 'completed' && "bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400",
                          (agent.status === 'running' || agent.status === 'pending') && "bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400",
                          (agent.status === 'failed' || agent.status === 'stopped') && "bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400"
                        )}
                      >
                        {agent.status || 'unknown'}
                      </Badge>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
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

