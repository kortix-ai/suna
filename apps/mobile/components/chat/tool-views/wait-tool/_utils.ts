import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface WaitData {
  seconds: number;
  success: boolean;
}

export function extractWaitData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): WaitData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  const seconds = args?.seconds || 0;
  
  return {
    seconds,
    success: toolResult?.success ?? true
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  } else {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
}

