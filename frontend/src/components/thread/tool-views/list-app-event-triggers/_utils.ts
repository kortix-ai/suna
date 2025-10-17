import { parseToolResult } from '../tool-result-parser';

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

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

export function extractListAppEventTriggersData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ListAppEventTriggersData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: ListAppEventTriggersData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    toolkit_slug: null,
    message: null,
    items: [],
    toolkit: null,
    total: 0,
    actualIsSuccess: isSuccess || false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  try {
    if (toolContent) {
      let content = toolContent;
      
      if (typeof toolContent === 'string') {
        try {
          content = JSON.parse(toolContent);
        } catch (e) {
          content = toolContent;
        }
      }

      if (content && typeof content === 'object' && content.content) {
        try {
          const nestedContent = typeof content.content === 'string' ? JSON.parse(content.content) : content.content;
          content = nestedContent;
        } catch (e) {
        }
      }

      if (content && typeof content === 'object' && content.tool_execution) {
        const toolExecution = content.tool_execution;
        if (toolExecution.result && toolExecution.result.success) {
          const args = toolExecution.arguments;
          const output = toolExecution.result.output;

          if (args && output) {
            return {
              ...defaultResult,
              toolkit_slug: args.toolkit_slug || null,
              message: output.message || null,
              items: output.items || [],
              toolkit: output.toolkit || null,
              total: output.total || 0,
              actualIsSuccess: true
            };
          }
        }
      }

      if (content && typeof content === 'object' && content.tool === 'list-app-event-triggers') {
        const parameters = content.parameters;
        const output = content.output;
        
        if (parameters && output) {
          return {
            ...defaultResult,
            toolkit_slug: parameters.toolkit_slug || null,
            message: output.message || null,
            items: output.items || [],
            toolkit: output.toolkit || null,
            total: output.total || 0,
            actualIsSuccess: output.success !== false
          };
        }
      }
    }

    if (assistantContent) {
      const parsed = parseToolResult(assistantContent);
      if (parsed && parsed.isSuccess) {
        const toolOutput = parseContent(parsed.toolOutput);
        const args = parsed.arguments;

        if (args && toolOutput) {
          return {
            ...defaultResult,
            toolkit_slug: args.toolkit_slug || null,
            message: toolOutput.message || null,
            items: toolOutput.items || [],
            toolkit: toolOutput.toolkit || null,
            total: toolOutput.total || 0,
            actualIsSuccess: true
          };
        }
      }
    }

    return defaultResult;
  } catch (error) {
    console.error('Error extracting list app event triggers data:', error);
    return defaultResult;
  }
}
