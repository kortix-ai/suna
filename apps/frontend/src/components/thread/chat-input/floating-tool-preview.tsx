import React from 'react';
import { Maximize2 } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { getToolIcon, getUserFriendlyToolName, extractPrimaryParam } from '@/components/thread/utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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

function convertToolName(toolName: string){
  if(toolName.includes('_')){
    return toolName.replace('_', '-');
  }
  return toolName;
}

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

  const toolName = currentToolCall.toolCall?.function_name || 'Tool Call';
  const CurrentToolIcon = getToolIcon(convertToolName(toolName));

  const displayParams = paramsDisplay || extractPrimaryParam(
    toolName, 
    currentToolCall.toolCall?.arguments ? JSON.stringify(currentToolCall.toolCall.arguments) : undefined
  );

  const isStreaming = !currentToolCall.toolResult;
  const isSuccess = isStreaming ? true : getToolResultStatus(currentToolCall);

  return (
    <motion.div 
      className="-mb-4 w-full"
      style={{ pointerEvents: 'auto' }}
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
    >
      <motion.div
        layoutId="kortix-computer-window"
        className="bg-card border border-border rounded-3xl p-2 w-full cursor-pointer group"
        onClick={onExpand}
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.99 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
      >
        <motion.div 
          className="flex items-center gap-3"
          layout="position"
        >
          <div className="flex-shrink-0">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center bg-gradient-to-br from-zinc-500/20 to-zinc-600/10 border border-zinc-500/20">
              {isStreaming ? (
                <KortixLoader size="small" />
              ) : (
                <CurrentToolIcon className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium text-foreground truncate">
                  {getUserFriendlyToolName(toolName)}
                </h4>
              </div>
              {displayParams && (
                <p className="text-xs text-muted-foreground truncate">
                  {displayParams}
                </p>
              )}
            </div>

            <div 
              className={cn(
                "flex-shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-full",
                isStreaming
                  ? "bg-blue-500/10"
                  : isSuccess
                    ? "bg-green-500/10"
                    : "bg-red-500/10"
              )}
            >
              <div className={cn(
                "w-1.5 h-1.5 rounded-full",
                isStreaming
                  ? "bg-blue-500 animate-pulse"
                  : isSuccess
                    ? "bg-green-500 animate-pulse"
                    : "bg-red-500"
              )} />
              <span className={cn(
                "text-xs font-medium whitespace-nowrap",
                isStreaming
                  ? "text-blue-500"
                  : isSuccess
                    ? "text-green-500"
                    : "text-red-500"
              )}>
                {isStreaming
                  ? `${agentName || 'Kortix'} is working...`
                  : isSuccess
                    ? "Success"
                    : "Failed"
                }
              </span>
            </div>
          </div>

          {showIndicators && indicatorTotal === 2 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const nextIndex = indicatorIndex === 0 ? 1 : 0;
                onIndicatorClick?.(nextIndex);
              }}
              className="flex items-center gap-1.5 mr-3 px-2 py-1.5 rounded-lg hover:bg-muted/30 transition-colors"
            >
              {Array.from({ length: indicatorTotal }).map((_, index) => (
                <div
                  key={index}
                  className={cn(
                    "transition-all duration-300 ease-out rounded-full",
                    index === indicatorIndex
                      ? "w-6 h-2 bg-foreground"
                      : "w-3 h-2 bg-muted-foreground/40"
                  )}
                />
              ))}
            </button>
          )}
          <Button variant='ghost' className="bg-transparent hover:bg-transparent flex-shrink-0">
            <Maximize2 className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
          </Button>
        </motion.div>
      </motion.div>
    </motion.div>
  );
};
