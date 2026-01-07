import React from 'react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { ToolCallInput } from '@/components/thread/kortix-computer';
import { motion } from 'framer-motion';

export type { ToolCallInput };

interface FloatingToolPreviewProps {
  toolCalls: ToolCallInput[];
  currentIndex: number;
  onExpand: () => void;
  agentName?: string;
  isVisible: boolean;
  showIndicators?: boolean;
  indicatorIndex?: number;
  indicatorTotal?: number;
  onIndicatorClick?: (index: number) => void;
  paramsDisplay?: string;
  onAnimationComplete?: () => void;
}

const getToolResultStatus = (toolCall: ToolCallInput): boolean => {
  if (toolCall.toolResult?.success !== undefined) {
    return toolCall.toolResult.success;
  }
  if (toolCall.isSuccess !== undefined) {
    return toolCall.isSuccess;
  }
  return true;
};

export const FloatingToolPreview: React.FC<FloatingToolPreviewProps> = ({
  toolCalls,
  currentIndex,
  onExpand,
  agentName,
  isVisible,
  showIndicators = false,
  indicatorIndex = 0,
  indicatorTotal = 1,
  onIndicatorClick,
  paramsDisplay,
  onAnimationComplete,
}) => {
  const currentToolCall = toolCalls[currentIndex];
  const totalCalls = toolCalls.length;

  if (!currentToolCall || totalCalls === 0) return null;
  if (!isVisible) return null;

  const isStreaming = !currentToolCall.toolResult;
  const isSuccess = isStreaming ? true : getToolResultStatus(currentToolCall);

  return (
    <motion.div 
      className="-mb-4 w-full flex justify-end"
      style={{ pointerEvents: 'auto' }}
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
    >
      <motion.div
        layoutId="kortix-computer-window"
        className="bg-card border border-border rounded-2xl px-3 py-2 cursor-pointer group inline-flex items-center gap-2"
        onClick={onExpand}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
      >
        {/* Computer icon */}
        <div className="w-5 h-5 flex items-center justify-center">
          {isStreaming ? (
            <KortixLoader customSize={14} />
          ) : (
            <svg 
              viewBox="0 0 24 24" 
              className={cn(
                "w-4 h-4",
                isSuccess ? "text-foreground" : "text-red-500"
              )}
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2" 
              strokeLinecap="round" 
              strokeLinejoin="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          )}
        </div>

        {/* Three dots */}
        <div className="flex items-center gap-1">
          <div className={cn(
            "w-1.5 h-1.5 rounded-full transition-colors",
            isStreaming 
              ? "bg-blue-500 animate-pulse" 
              : isSuccess 
                ? "bg-foreground/60 group-hover:bg-foreground" 
                : "bg-red-500"
          )} />
          <div className={cn(
            "w-1.5 h-1.5 rounded-full transition-colors",
            isStreaming 
              ? "bg-blue-500 animate-pulse [animation-delay:150ms]" 
              : isSuccess 
                ? "bg-foreground/60 group-hover:bg-foreground" 
                : "bg-red-500"
          )} />
          <div className={cn(
            "w-1.5 h-1.5 rounded-full transition-colors",
            isStreaming 
              ? "bg-blue-500 animate-pulse [animation-delay:300ms]" 
              : isSuccess 
                ? "bg-foreground/60 group-hover:bg-foreground" 
                : "bg-red-500"
          )} />
        </div>
      </motion.div>
    </motion.div>
  );
};
