import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { KortixLoader } from '@/components/ui/kortix-loader';

interface LoadingStateProps {
  title: string;
  subtitle?: string;
  showProgress?: boolean;
  /** @deprecated Kept for backward compat with inactive views — ignored */
  icon?: unknown;
  /** @deprecated Kept for backward compat with inactive views — ignored */
  iconColor?: string;
  /** @deprecated Kept for backward compat with inactive views — ignored */
  bgColor?: string;
  /** @deprecated Kept for backward compat with inactive views — ignored */
  filePath?: string | null;
  /** @deprecated Kept for backward compat with inactive views — ignored */
  progressText?: string;
  /** @deprecated Kept for backward compat with inactive views — ignored */
  autoProgress?: boolean;
  /** @deprecated Kept for backward compat with inactive views — ignored */
  initialProgress?: number;
  /** @deprecated Kept for backward compat with inactive views — ignored */
  useKortixLoader?: boolean;
}

export function LoadingState({
  title,
  subtitle,
  showProgress = true,
}: LoadingStateProps): React.JSX.Element {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!showProgress) return;
    const timer = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 95) { clearInterval(timer); return prev; }
        return prev + Math.random() * 10 + 5;
      });
    }, 500);
    return () => clearInterval(timer);
  }, [showProgress]);

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[180px] py-6 px-4">
      <div className="text-center w-full max-w-xs flex flex-col items-center">
        <KortixLoader customSize={16} />
        <h3 className="mt-3 text-sm font-medium text-foreground tracking-tight">{title}</h3>
        {subtitle && (
          <p className="mt-1 text-xs text-muted-foreground/70 truncate">{subtitle}</p>
        )}
        {showProgress && (
          <div className="mt-3 w-full">
            <Progress value={Math.min(progress, 100)} className="w-full h-px" />
          </div>
        )}
      </div>
    </div>
  );
}
