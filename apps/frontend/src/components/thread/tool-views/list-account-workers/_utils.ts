import { ToolCallData, ToolResultData } from '../types';

export interface AccountWorkerItem {
  agent_id: string;
  name: string;
  is_default: boolean;
  is_kortix: boolean;
  is_current: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ListAccountWorkersData {
  search: string | null;
  include_kortix: boolean;
  message: string | null;
  workers: AccountWorkerItem[];
  total: number;
  errorMessage: string | null;
}

function parseToolArguments(toolCall: ToolCallData): Record<string, any> {
  if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
    return toolCall.arguments;
  }

  if (typeof toolCall.arguments === 'string') {
    try {
      return JSON.parse(toolCall.arguments);
    } catch {
      return {};
    }
  }

  return {};
}

export function extractListAccountWorkersData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string,
): ListAccountWorkersData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const args = parseToolArguments(toolCall);

  let parsedOutput: any = {};
  let rawOutputMessage: string | null = null;

  if (toolResult?.output !== undefined && toolResult?.output !== null) {
    if (typeof toolResult.output === 'object') {
      parsedOutput = toolResult.output;
    } else if (typeof toolResult.output === 'string') {
      try {
        parsedOutput = JSON.parse(toolResult.output);
      } catch {
        rawOutputMessage = toolResult.output;
      }
    }
  }

  const workers: AccountWorkerItem[] = Array.isArray(parsedOutput.workers)
    ? parsedOutput.workers
    : [];

  const total = typeof parsedOutput.total === 'number' ? parsedOutput.total : workers.length;
  const actualIsSuccess = toolResult?.success ?? parsedOutput.success ?? isSuccess;
  const message = typeof parsedOutput.message === 'string' ? parsedOutput.message : null;
  const errorMessage = !actualIsSuccess
    ? (toolResult?.error || rawOutputMessage || message || 'Failed to list account workers')
    : null;

  return {
    search: typeof args.search === 'string' ? args.search : null,
    include_kortix: Boolean(args.include_kortix),
    message,
    workers,
    total,
    errorMessage,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
  };
}
