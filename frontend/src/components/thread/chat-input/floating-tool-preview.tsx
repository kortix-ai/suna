import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CircleDashed, Maximize2 } from 'lucide-react';
import { getToolIcon, getUserFriendlyToolName } from '@/components/thread/utils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ToolCallInput } from '@/components/thread/tool-call-side-panel';

// Re-export for use in chat-snack.tsx
export type { ToolCallInput };

interface FloatingToolPreviewProps {
  toolCalls: ToolCallInput[];
  currentIndex: number;
  onExpand: () => void;
  agentName?: string;
  isVisible: boolean;
  // Indicators for multiple notification types (not tool calls)
  showIndicators?: boolean;
  indicatorIndex?: number;
  indicatorTotal?: number;
  onIndicatorClick?: (index: number) => void;
}

const FLOATING_LAYOUT_ID = 'tool-panel-float';
const CONTENT_LAYOUT_ID = 'tool-panel-content';

const getToolResultStatus = (toolCall: ToolCallInput): boolean => {
  // Use the structured toolResult from metadata
  if (toolCall.toolResult?.success !== undefined) {
    return toolCall.toolResult.success;
  }
  
  // Fallback to isSuccess if available
  if (toolCall.isSuccess !== undefined) {
    return toolCall.isSuccess;
  }
  
  // Default to true if no result yet (streaming)
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
}) => {
  const [isExpanding, setIsExpanding] = React.useState(false);
  const currentToolCall = toolCalls[currentIndex];
  const totalCalls = toolCalls.length;

  React.useEffect(() => {
    if (isVisible) {
      setIsExpanding(false);
    }
  }, [isVisible]);

  if (!currentToolCall || totalCalls === 0) return null;

  // Get tool name from the structured toolCall data
  const toolName = currentToolCall.toolCall?.function_name || 'Tool Call';
  const CurrentToolIcon = getToolIcon(toolName);
  // Check if streaming: no toolResult means it's still streaming
  const isStreaming = !currentToolCall.toolResult;
  const isSuccess = isStreaming ? true : getToolResultStatus(currentToolCall);

  const handleClick = () => {
    setIsExpanding(true);
    requestAnimationFrame(() => {
      onExpand();
    });
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          layoutId={FLOATING_LAYOUT_ID}
          layout
          transition={{
            layout: {
              type: "spring",
              stiffness: 300,
              damping: 30
            }
          }}
          className="-mb-4 w-full"
          style={{ pointerEvents: 'auto' }}
        >
          <motion.div
            layoutId={CONTENT_LAYOUT_ID}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            className="bg-card border border-border rounded-3xl p-2 w-full cursor-pointer group"
            onClick={handleClick}
            style={{ opacity: isExpanding ? 0 : 1 }}
          >
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0">
                <motion.div
                  layoutId="tool-icon"
                  className={cn(
                    "w-10 h-10 rounded-2xl flex items-center justify-center",
                    isStreaming
                      ? "bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800"
                      : isSuccess
                        ? "bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-800"
                        : "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                  )}
                  style={{ opacity: isExpanding ? 0 : 1 }}
                >
                  {isStreaming ? (
                    <CircleDashed className="h-5 w-5 text-blue-500 dark:text-blue-400 animate-spin" style={{ opacity: isExpanding ? 0 : 1 }} />
                  ) : (
                    <CurrentToolIcon className="h-5 w-5 text-foreground" style={{ opacity: isExpanding ? 0 : 1 }} />
                  )}
                </motion.div>
              </div>

              <div className="flex-1 min-w-0" style={{ opacity: isExpanding ? 0 : 1 }}>
                <motion.div layoutId="tool-title" className="flex items-center gap-2 mb-1">
                  <h4 className="text-sm font-medium text-foreground truncate">
                    {getUserFriendlyToolName(toolName)}
                  </h4>
                </motion.div>

                <motion.div layoutId="tool-status" className="flex items-center gap-2">
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    isStreaming
                      ? "bg-blue-500 animate-pulse"
                      : isSuccess
                        ? "bg-green-500"
                        : "bg-red-500"
                  )} />
                  <span className="text-xs text-muted-foreground truncate">
                    {isStreaming
                      ? `${agentName || 'Suna'} is working...`
                      : isSuccess
                        ? "Success"
                        : "Failed"
                    }
                  </span>
                </motion.div>
              </div>

              {/* Apple-style notification indicators - only for multiple notification types */}
              {showIndicators && indicatorTotal === 2 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation(); // Prevent tool expansion
                    // Toggle between the two notifications (binary switch)
                    const nextIndex = indicatorIndex === 0 ? 1 : 0;
                    onIndicatorClick?.(nextIndex);
                  }}
                  className="flex items-center gap-1.5 mr-3 px-2 py-1.5 rounded-lg hover:bg-muted/30 transition-colors"
                  style={{ opacity: isExpanding ? 0 : 1 }}
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

              <Button value='ghost' className="bg-transparent hover:bg-transparent flex-shrink-0" style={{ opacity: isExpanding ? 0 : 1 }}>
                <Maximize2 className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}; 