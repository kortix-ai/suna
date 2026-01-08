import React from 'react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { getToolIcon } from '../../utils';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';

export interface ToolViewWrapperProps extends ToolViewProps {
  children: React.ReactNode;
  headerContent?: React.ReactNode;
  footerContent?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
  footerClassName?: string;
  showStatus?: boolean;
  customStatus?: {
    success?: string;
    failure?: string;
    streaming?: string;
  };
}

export function ToolViewWrapper({
  toolCall,
  isSuccess = true,
  isStreaming = false,
  assistantTimestamp,
  toolTimestamp,
  children,
  headerContent,
  footerContent,
  className,
  contentClassName,
  headerClassName,
  footerClassName,
  showStatus = true,
  customStatus,
}: ToolViewWrapperProps) {
  // Derive name from toolCall.function_name
  const name = toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || 'unknown';
  const toolTitle = getToolTitle(name);
  const Icon = getToolIcon(name);

  return (
    <div className={cn("flex flex-col h-full max-w-full overflow-hidden min-w-0", className)}>
      {(headerContent || showStatus) && (
        <div className={cn(
          "flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 justify-between border-zinc-200 dark:border-zinc-800 max-w-full min-w-0",
          headerClassName
        )}>
          <div className="flex ml-1 items-center min-w-0 flex-1">
            {Icon && <Icon className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400 flex-shrink-0" />}
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate min-w-0">
              {toolTitle}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isStreaming && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
                <span className="text-[10px] font-medium text-zinc-700 dark:text-zinc-400">Running</span>
              </div>
            )}
            {headerContent}
          </div>
        </div>
      )}

      <div className={cn("flex-1 overflow-auto max-w-full min-w-0", contentClassName)}>
        {children}
      </div>

      {(footerContent || showStatus) && (
        <div className={cn(
          "p-4 border-t border-zinc-200 dark:border-zinc-800",
          footerClassName
        )}>
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
            {!isStreaming && showStatus && (
              <div className="flex items-center gap-2">
                {isSuccess ? (
                  <CheckCircle className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                )}
                <span>
                  {isSuccess
                    ? customStatus?.success || "Completed successfully"
                    : customStatus?.failure || "Execution failed"}
                </span>
              </div>
            )}

            {isStreaming && showStatus && (
              <div className="flex items-center gap-2">
                <KortixLoader customSize={14} />
                <span>{customStatus?.streaming || "Processing..."}</span>
              </div>
            )}

            <div className="text-xs">
              {toolTimestamp && !isStreaming
                ? formatTimestamp(toolTimestamp)
                : assistantTimestamp
                  ? formatTimestamp(assistantTimestamp)
                  : ""}
            </div>

            {footerContent}
          </div>
        </div>
      )}
    </div>
  );
} 
