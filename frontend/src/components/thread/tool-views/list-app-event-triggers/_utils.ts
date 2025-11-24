import { ToolCallData, ToolResultData } from '../types';

export interface TriggerConfig {
  properties: Record<string, any>;
  title?: string;
  type?: string;
}

export interface TriggerPayload {
  properties: Record<string, any>;
  title?: string;
  type?: string;
}

export interface ToolkitInfo {
  slug: string;
  name: string;
  logo?: string;
}

export interface EventTrigger {
  slug: string;
  name: string;
  description: string;
  type: string;
  instructions?: string;
  toolkit?: ToolkitInfo;
  config?: TriggerConfig;
  payload?: TriggerPayload;
}

export interface ListAppEventTriggersData {
  toolkit_slug: string | null;
  message: string | null;
  items: EventTrigger[];
  toolkit: ToolkitInfo | null;
  total: number;
  success?: boolean;
  timestamp?: string;
}

export function extractListAppEventTriggersData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ListAppEventTriggersData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const defaultResult: ListAppEventTriggersData & {
    actualIsSuccess: boolean;
    actualToolTimestamp?: string;
    actualAssistantTimestamp?: string;
  } = {
    toolkit_slug: null,
    message: null,
    items: [],
    toolkit: null,
    total: 0,
    actualIsSuccess: isSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  if (!toolResult?.output) {
    return defaultResult;
  }

  let parsedOutput: any = toolResult.output;
  if (typeof parsedOutput === 'string') {
    try {
      parsedOutput = JSON.parse(parsedOutput);
    } catch (e) {
      return { ...defaultResult, actualIsSuccess: false };
    }
  }

  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
      : {};

  return {
    toolkit_slug: parsedOutput.toolkit_slug || args.toolkit_slug || null,
    message: parsedOutput.message || null,
    items: Array.isArray(parsedOutput.items) ? parsedOutput.items : [],
    toolkit: parsedOutput.toolkit || null,
    total: parsedOutput.total ?? 0,
    success: parsedOutput.success,
    timestamp: parsedOutput.timestamp,
    actualIsSuccess: parsedOutput.success ?? isSuccess,
    actualToolTimestamp: parsedOutput.timestamp || toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
