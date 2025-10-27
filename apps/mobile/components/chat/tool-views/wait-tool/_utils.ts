import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface WaitData {
  seconds: number;
  success: boolean;
}

export function extractWaitData(toolData: ParsedToolData): WaitData {
  const { arguments: args, result } = toolData;
  
  const seconds = args?.seconds || 0;
  
  return {
    seconds,
    success: result.success ?? true
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

