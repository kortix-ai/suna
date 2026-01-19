import React, { useState, useEffect } from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
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
  /** If true, uses KortixLoader instead of the icon */
  useKortixLoader?: boolean;
}

export function LoadingState({
  icon: Icon,
  iconColor = 'text-zinc-500 dark:text-zinc-400',
  bgColor = 'bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60 dark:shadow-zinc-950/20',
  title,
  subtitle,
  filePath,
  showProgress = true,
  progressText,
  autoProgress = true,
  initialProgress = 0,
  useKortixLoader = true,
}: LoadingStateProps): React.JSX.Element {
  const [progress, setProgress] = useState(initialProgress);

  useEffect(() => {
    if (showProgress && autoProgress) {
      setProgress(0);
      const timer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            clearInterval(timer);
            return prevProgress;
          }
          return prevProgress + Math.random() * 10 + 5;
        });
      }, 500);
      return () => clearInterval(timer);
    }
  }, [showProgress, autoProgress]);
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] overflow-hidden scrollbar-hide py-12 px-6">
      <div className="text-center w-full max-w-sm">
        <div className={cn("w-12 h-12 rounded-full mx-auto mb-6 flex items-center justify-center", bgColor)}>
          {useKortixLoader ? (
            <KortixLoader customSize={20} />
          ) : Icon ? (
            <Icon className={cn("h-5 w-5", iconColor)} />
          ) : (
            <KortixLoader customSize={20} />
          )}
        </div>
        
        <h3 className="text-xl font-semibold mb-4 text-zinc-900 dark:text-zinc-100">
          {title}
        </h3>
        
        {filePath && (
          <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 w-full text-center mb-6 shadow-sm">
            <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
              {filePath}
            </code>
          </div>
        )}
        
        {showProgress && (
          <div className="space-y-3">
            <Progress value={Math.min(progress, 100)} className="w-full h-1" />
            <div className="flex justify-center items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span>{progressText || 'Processing...'}</span>
              <span className="font-mono">{Math.round(Math.min(progress, 100))}%</span>
            </div>
          </div>
        )}
        
        {subtitle && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-4">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
} 