import { parseToolResult } from '../tool-result-parser';

export interface WorkflowItem {
  id: string;
  name: string;
  description?: string;
  trigger_phrase?: string;
  is_default: boolean;
  status: string;
  created_at: string;
  updated_at: string;
  steps_count: number;
}

export interface ListAgentWorkflowsData {
  agent_id: string | null;
  workflows: WorkflowItem[] | null;
  total_count: number;
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

export function extractListAgentWorkflowsData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ListAgentWorkflowsData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: ListAgentWorkflowsData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    agent_id: null,
    workflows: null,
    total_count: 0,
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
              agent_id: args.agent_id || output.agent_id || null,
              workflows: output.workflows || [],
              total_count: output.total_count || 0,
              actualIsSuccess: true
            };
          }
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
            agent_id: args.agent_id || toolOutput.agent_id || null,
            workflows: toolOutput.workflows || [],
            total_count: toolOutput.total_count || 0,
            actualIsSuccess: true
          };
        }
      }
    }

    return defaultResult;
  } catch (error) {
    console.error('Error extracting list agent workflows data:', error);
    return defaultResult;
  }
} 