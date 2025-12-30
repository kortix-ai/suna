'use client';

import { memo, ReactNode, useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Folder, Globe, TerminalSquare, Info, Table } from 'lucide-react';
import { getUserFriendlyToolName, getToolIcon } from '@/components/thread/utils';
import { cn } from '@/lib/utils';
import { ToolCallInput } from '../KortixComputer';
import { AppIcon } from '../../tool-views/shared/AppIcon';
import { ViewType } from '@/stores/kortix-computer-store';

const convertToolName = (toolName: string) => {
  if (toolName.includes('_')) {
    return toolName.replace(/_/g, '-');
  }
  return toolName;
};

const getToolColorScheme = (toolName: string): { bg: string; iconColor: string } => {
  const normalized = toolName?.toLowerCase() || '';

  if (normalized.includes('browser') || normalized.includes('web') || normalized.includes('crawl') || normalized.includes('scrape')) {
    return { bg: 'bg-gradient-to-br from-[#38bdf8] to-[#0284c7]', iconColor: 'text-white' };
  }

  if (normalized.includes('file') || normalized.includes('create-file') || normalized.includes('edit-file') || normalized.includes('read-file') || normalized.includes('delete-file') || normalized.includes('full-file-rewrite') || normalized.includes('str-replace')) {
    return { bg: 'bg-gradient-to-br from-[#60a5fa] to-[#2563eb]', iconColor: 'text-white' };
  }

  if (normalized.includes('execute-command') || normalized.includes('terminal') || normalized.includes('command') || normalized.includes('check-command')) {
    return { bg: 'bg-gradient-to-br from-[#3f3f46] to-[#18181b]', iconColor: 'text-[#4ade80]' };
  }

  if (normalized.includes('search')) {
    return { bg: 'bg-gradient-to-br from-[#c084fc] to-[#7e22ce]', iconColor: 'text-white' };
  }

  if (normalized.includes('task') || normalized.includes('complete') || normalized.includes('list')) {
    return { bg: 'bg-gradient-to-br from-[#fbbf24] to-[#d97706]', iconColor: 'text-white' };
  }

  if (normalized.includes('phone') || normalized.includes('call') || normalized.includes('vapi')) {
    return { bg: 'bg-gradient-to-br from-[#4ade80] to-[#16a34a]', iconColor: 'text-white' };
  }

  if (normalized.includes('sheet') || normalized.includes('table')) {
    return { bg: 'bg-gradient-to-br from-[#34d399] to-[#059669]', iconColor: 'text-white' };
  }

  if (normalized.includes('slide') || normalized.includes('presentation')) {
    return { bg: 'bg-gradient-to-br from-[#818cf8] to-[#4f46e5]', iconColor: 'text-white' };
  }

  if (normalized.includes('ask') || normalized.includes('message')) {
    return { bg: 'bg-gradient-to-br from-[#22d3ee] to-[#0891b2]', iconColor: 'text-white' };
  }

  if (normalized.includes('code') || normalized.includes('execute-code')) {
    return { bg: 'bg-gradient-to-br from-[#2dd4bf] to-[#0f766e]', iconColor: 'text-white' };
  }

  if (normalized.includes('network') || normalized.includes('data-provider') || normalized.includes('api')) {
    return { bg: 'bg-gradient-to-br from-[#f472b6] to-[#db2777]', iconColor: 'text-white' };
  }

  if (normalized.includes('mcp') || normalized.includes('plug') || normalized.includes('initialize')) {
    return { bg: 'bg-gradient-to-br from-[#a78bfa] to-[#7c3aed]', iconColor: 'text-white' };
  }

  if (normalized.includes('expose-port') || normalized.includes('computer')) {
    return { bg: 'bg-gradient-to-br from-[#9ca3af] to-[#4b5563]', iconColor: 'text-white' };
  }

  return { bg: 'bg-gradient-to-br from-[#94a3b8] to-[#64748b]', iconColor: 'text-white' };
};

const isExternalAppTool = (toolCall: any): boolean => {
  const functionName = toolCall?.function_name?.toLowerCase() || '';
  return functionName.startsWith('composio_') || 
         functionName.includes('_app_') ||
         (toolCall?.arguments && typeof toolCall.arguments === 'string' && toolCall.arguments.includes('app_slug'));
};

interface DockProps {
  children: ReactNode;
  className?: string;
}

interface DockCardProps {
  toolCall: any;
  toolName: string;
  label: string;
  isActive?: boolean;
  isRunning?: boolean;
  isFailed?: boolean;
  onClick?: () => void;
}

const ICON_SIZE = 40;

export function Dock({ children, className }: DockProps) {
  return (
    <div className="relative isolate">
      <div className="absolute inset-x-0 bottom-0 h-[56px] pointer-events-none" style={{ zIndex: -1 }}>
        <div
          className={cn("h-full w-full border bg-background/40 backdrop-blur-2xl rounded-xl", className)}
        >
        </div>
      </div>
      <div className="relative flex h-[56px] items-end gap-1.5 px-2.5 pb-1.5" style={{ zIndex: 1 }}>
        {children}
      </div>
    </div>
  );
}

export const DockCard = memo(function DockCard({
  toolCall,
  toolName,
  label,
  isActive = false,
  isRunning = false,
  isFailed = false,
  onClick,
}: DockCardProps) {
  const FallbackIcon = getToolIcon(convertToolName(toolName));
  const isExternalApp = isExternalAppTool(toolCall);
  const colorScheme = getToolColorScheme(convertToolName(toolName));

  return (
    <div className="relative flex flex-col items-center group">
      <motion.button
        type="button"
        onClick={() => onClick?.()}
        style={{ width: ICON_SIZE, height: ICON_SIZE }}
        className={cn(
          "flex items-center justify-center relative cursor-pointer p-2 rounded-xl",
          "transition-transform duration-150",
          isExternalApp
            ? "bg-white border border-black/10"
            : cn(colorScheme.bg, "border border-white/20"),
          isActive && "ring-2 ring-white/40"
        )}
        whileTap={{ scale: 0.95 }}
      >
        {isExternalApp ? (
          <AppIcon 
            toolCall={toolCall} 
            size={64}
            fallbackIcon={FallbackIcon}
            className="w-full h-full object-contain pointer-events-none"
          />
        ) : (
          <FallbackIcon 
            className={cn(
              "w-3/5 h-3/5 pointer-events-none",
              colorScheme.iconColor
            )}
          />
        )}
      </motion.button>
      
      {isFailed && (
        <div className="absolute -top-1 -right-1 w-5 h-5 bg-destructive rounded-full flex items-center justify-center border-2 border-white z-10">
          <span className="text-[10px] text-white font-bold">!</span>
        </div>
      )}

      <div 
        className={cn(
          "absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 text-white text-[10px] font-medium rounded-md whitespace-nowrap pointer-events-none z-50",
          "bg-black/80 backdrop-blur-xl border border-white/10",
          "opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        )}
        style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}
      >
        {label}
        <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-black/80" />
      </div>

    </div>
  );
});

DockCard.displayName = 'DockCard';

interface SystemDockCardProps {
  icon: React.ElementType;
  label: string;
  bgClass: string;
  iconColor: string;
  isActive?: boolean;
  onClick?: () => void;
}

export const SystemDockCard = memo(function SystemDockCard({
  icon: Icon,
  label,
  bgClass,
  iconColor,
  isActive = false,
  onClick,
}: SystemDockCardProps) {
  return (
    <div className="relative flex flex-col items-center group">
      <motion.button
        type="button"
        onClick={onClick}
        style={{ width: ICON_SIZE, height: ICON_SIZE }}
        className={cn(
          "flex items-center justify-center relative cursor-pointer p-2 rounded-xl",
          "transition-transform duration-150 border border-white/20",
          bgClass,
          isActive && "ring-2 ring-white/40"
        )}
        whileTap={{ scale: 0.95 }}
      >
        <Icon className={cn("w-3/5 h-3/5 pointer-events-none drop-shadow-md", iconColor)} />
      </motion.button>

      <div 
        className={cn(
          "absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 text-white text-[10px] font-medium rounded-md whitespace-nowrap pointer-events-none z-50",
          "bg-black/80 backdrop-blur-xl border border-white/10",
          "opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        )}
        style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}
      >
        {label}
        <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-black/80" />
      </div>

    </div>
  );
});

SystemDockCard.displayName = 'SystemDockCard';

interface AppDockProps {
  toolCalls: ToolCallInput[];
  currentIndex: number;
  onNavigate: (index: number) => void;
  onPrevious: () => void;
  onNext: () => void;
  latestIndex: number;
  agentStatus: string;
  isLiveMode: boolean;
  onJumpToLive: () => void;
  onJumpToLatest: () => void;
  isMaximized?: boolean;
  currentView?: ViewType;
  onViewChange?: (view: 'files' | 'browser' | 'terminal' | 'info' | 'spreadsheet') => void;
  showFilesTab?: boolean;
  isFilesWindowOpen?: boolean;
  isBrowserWindowOpen?: boolean;
  isTerminalWindowOpen?: boolean;
  isInfoWindowOpen?: boolean;
  isSpreadsheetWindowOpen?: boolean;
}

export const AppDock = memo(function AppDock({
  toolCalls,
  currentIndex,
  onNavigate,
  onPrevious,
  onNext,
  latestIndex,
  agentStatus,
  isLiveMode,
  onJumpToLive,
  onJumpToLatest,
  isMaximized = false,
  currentView = 'tools',
  onViewChange,
  showFilesTab = true,
  isFilesWindowOpen = false,
  isBrowserWindowOpen = false,
  isTerminalWindowOpen = false,
  isInfoWindowOpen = false,
  isSpreadsheetWindowOpen = false,
}: AppDockProps) {
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxVisibleIcons = 12;
  
  useEffect(() => {
    if (currentIndex < scrollOffset) {
      setScrollOffset(currentIndex);
    } else if (currentIndex >= scrollOffset + maxVisibleIcons) {
      setScrollOffset(Math.max(0, currentIndex - maxVisibleIcons + 1));
    }
  }, [currentIndex, scrollOffset, maxVisibleIcons]);
  
  if (toolCalls.length === 0) return null;

  const isToolRunning = (index: number) => {
    const tool = toolCalls[index];
    return !tool.toolResult && agentStatus === 'running';
  };

  const isToolFailed = (index: number) => {
    const tool = toolCalls[index];
    if (!tool.toolResult) return false;
    return tool.toolResult.success === false || tool.isSuccess === false;
  };

  const startIndex = scrollOffset;
  const endIndex = Math.min(toolCalls.length, startIndex + maxVisibleIcons);
  
  const visibleTools = toolCalls.slice(startIndex, endIndex);

  const canNavigateLeft = currentIndex > 0;
  const canNavigateRight = currentIndex < latestIndex;

  const showJumpButton = !isLiveMode;

  return (
    <motion.footer
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 80, opacity: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 28, mass: 0.8 }}
      className="absolute bottom-0 left-0 right-0 flex-shrink-0 w-full z-50"
    >
      <div className="relative flex items-center justify-center py-3 px-4 max-w-full">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: canNavigateLeft ? 1 : 0.4, scale: 1 }}
          whileTap={canNavigateLeft ? { scale: 0.92 } : undefined}
          className="absolute left-4"
        >
          <div
            className='border bg-background/30 backdrop-blur-xl rounded-full hover:bg-background/50 transition-colors duration-150'
          >
            <button
              type="button"
              onClick={onPrevious}
              disabled={!canNavigateLeft}
              className={cn(
                "flex items-center justify-center w-7 h-7",
                canNavigateLeft ? "cursor-pointer text-white" : "cursor-not-allowed text-white/50"
              )}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          </div>
        </motion.div>
        <Dock>
          {isMaximized && (
            <>
              {showFilesTab && (
                <SystemDockCard
                  icon={Folder}
                  label="Files"
                  bgClass="bg-gradient-to-br from-[#60a5fa] to-[#2563eb]"
                  iconColor="text-white"
                  isActive={isFilesWindowOpen}
                  onClick={() => onViewChange?.('files')}
                />
              )}
              <SystemDockCard
                icon={Globe}
                label="Browser"
                bgClass="bg-gradient-to-br from-[#38bdf8] to-[#0284c7]"
                iconColor="text-white"
                isActive={isBrowserWindowOpen}
                onClick={() => onViewChange?.('browser')}
              />
              <SystemDockCard
                icon={TerminalSquare}
                label="Terminal"
                bgClass="bg-gradient-to-br from-[#3f3f46] to-[#18181b]"
                iconColor="text-[#4ade80]"
                isActive={isTerminalWindowOpen}
                onClick={() => onViewChange?.('terminal')}
              />
              <SystemDockCard
                icon={Info}
                label="System Info"
                bgClass="bg-gradient-to-br from-[#64748B] to-[#475569]"
                iconColor="text-white"
                isActive={isInfoWindowOpen}
                onClick={() => onViewChange?.('info')}
              />
              <SystemDockCard
                icon={Table}
                label="Spreadsheets"
                bgClass="bg-gradient-to-br from-[#10b981] to-[#059669]"
                iconColor="text-white"
                isActive={isSpreadsheetWindowOpen}
                onClick={() => onViewChange?.('spreadsheet')}
              />
            </>
          )}
          {/* {visibleTools.map((toolCallInput, i) => {
            const actualIndex = startIndex + i;
            const toolName = toolCallInput.toolCall?.function_name || 'tool';
            return (
              <DockCard
                key={`${actualIndex}-${toolName}`}
                toolCall={toolCallInput.toolCall}
                toolName={toolName}
                label={getUserFriendlyToolName(toolName)}
                isActive={actualIndex === currentIndex}
                isRunning={isToolRunning(actualIndex)}
                isFailed={isToolFailed(actualIndex)}
                onClick={() => onNavigate(actualIndex)}
              />
            );
          })} */}
        </Dock>
        <div className="absolute right-4 flex items-center gap-2">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: canNavigateRight ? 1 : 0.4, scale: 1 }}
            whileTap={canNavigateRight ? { scale: 0.92 } : undefined}
          >
            <div
              className='border bg-background/30 backdrop-blur-xl rounded-full hover:bg-background/50 transition-colors duration-150'
            >
              <button
                type="button"
                onClick={onNext}
                disabled={!canNavigateRight}
                className={cn(
                  "flex items-center justify-center w-7 h-7",
                  canNavigateRight ? "cursor-pointer text-white" : "cursor-not-allowed text-white/50"
                )}
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
          {showJumpButton && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              whileTap={{ scale: 0.95 }}
            >
              <div
                className='border bg-background/30 backdrop-blur-xl rounded-full hover:bg-background/50 transition-colors duration-150'
              >
                <button
                  type="button"
                  onClick={agentStatus === 'running' ? onJumpToLive : onJumpToLatest}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium whitespace-nowrap text-white"
                >
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    agentStatus === 'running' ? "bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.6)]" : "bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.6)]"
                  )} />
                  <span>{agentStatus === 'running' ? 'Jump to Live' : 'Jump to Latest'}</span>
                </button>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </motion.footer>
  );
});

AppDock.displayName = 'AppDock';
