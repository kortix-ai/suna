'use client';

import React from 'react';
import { LucideIcon, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { KortixLoader } from '@/components/ui/kortix-loader';

interface LoadingStateProps {
  icon?: LucideIcon;
  iconColor?: string;
  bgColor?: string;
  title: string;
  subtitle?: string;
  filePath?: string | null;
  showProgress?: boolean;
  progressText?: string;
  autoProgress?: boolean;
  initialProgress?: number;
  /** Use terminal style (dark bg, monospace) */
  terminalStyle?: boolean;
  /** Show the command being executed */
  command?: string;
}

export function LoadingState({
  icon: Icon = Terminal,
  iconColor = 'text-zinc-500 dark:text-zinc-400',
  bgColor,
  title,
  subtitle,
  filePath,
  showProgress = false,
  progressText,
  autoProgress = false,
  initialProgress = 0,
  terminalStyle = false,
  command,
}: LoadingStateProps): JSX.Element {
  
  // Terminal-style loading for command execution
  if (terminalStyle || command) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[280px] py-8 px-6">
        <div className="w-full max-w-md space-y-6">
          {/* Minimal header with loader */}
          <div className="flex items-center justify-center gap-3">
            <KortixLoader size="small" />
            <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
              {title}
            </span>
          </div>
          
          {/* Command display */}
          {command && (
            <div className="bg-zinc-900 dark:bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden shadow-lg">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                  <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                  <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                </div>
                <span className="text-[10px] text-zinc-500 font-mono ml-2">terminal</span>
              </div>
              <div className="p-4">
                <pre className="text-sm font-mono text-zinc-100 whitespace-pre-wrap break-all">
                  <span className="text-emerald-400">$</span>{' '}
                  <span className="text-zinc-100">{command}</span>
                  <span className="inline-block w-2 h-4 ml-0.5 bg-zinc-400 animate-pulse" />
                </pre>
              </div>
            </div>
          )}
          
          {/* Fallback for no command */}
          {!command && filePath && (
            <div className="bg-zinc-100 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
              <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
                {filePath}
              </code>
            </div>
          )}
          
          {subtitle && (
            <p className="text-xs text-center text-zinc-500 dark:text-zinc-500">
              {subtitle}
            </p>
          )}
        </div>
      </div>
    );
  }
  
  // Default minimal loading state
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[280px] py-8 px-6">
      <div className="text-center w-full max-w-sm space-y-5">
        {/* Icon with subtle background */}
        <div className={cn(
          "w-14 h-14 rounded-2xl mx-auto flex items-center justify-center",
          bgColor || "bg-zinc-100 dark:bg-zinc-800/80"
        )}>
          <Icon className={cn("h-6 w-6", iconColor)} />
        </div>
        
        {/* Title with loader */}
        <div className="space-y-3">
          <div className="flex items-center justify-center gap-2.5">
            <KortixLoader size="small" />
            <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
              {title}
            </h3>
          </div>
          
          {filePath && (
            <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3">
              <code className="text-sm font-mono text-zinc-600 dark:text-zinc-400 break-all">
                {filePath}
              </code>
            </div>
          )}
        </div>
        
        {subtitle && (
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}
