import { ToolCallData, ToolResultData } from '../types';

export interface ExposePortData {
  port: number | null;
  url: string | null;
  message: string | null;
  success?: boolean;
  timestamp?: string;
}

export function extractExposePortData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  port: number | null;
  url: string | null;
  message: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const args = toolCall.arguments || {};
  let port: number | null = null;
  let url: string | null = null;
  let message: string | null = null;
  
  // Extract port from arguments
  if (args.port !== undefined && args.port !== null) {
    port = typeof args.port === 'string' ? parseInt(args.port, 10) : Number(args.port);
  }
  
  // Extract URL and message from toolResult output
  if (toolResult?.output) {
    const output = toolResult.output;
    
    if (typeof output === 'string') {
      try {
        // Try to parse as JSON first
        const parsed = JSON.parse(output);
        url = parsed.url || null;
        message = parsed.message || null;
        if (parsed.port && !port) {
          port = typeof parsed.port === 'string' ? parseInt(parsed.port, 10) : Number(parsed.port);
        }
      } catch (e) {
        // Not JSON, check for URL pattern
        const urlMatch = output.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          url = urlMatch[0];
        }
        message = output;
      }
    } else if (typeof output === 'object' && output !== null) {
      const obj = output as any;
      url = obj.url || null;
      message = obj.message || obj.status || null;
      if (obj.port && !port) {
        port = typeof obj.port === 'string' ? parseInt(obj.port, 10) : Number(obj.port);
      }
    }
  }
  
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    port,
    url,
    message,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
} 