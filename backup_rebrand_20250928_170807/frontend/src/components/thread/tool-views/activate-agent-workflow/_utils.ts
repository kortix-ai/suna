import { parseToolResult } from '../tool-result-parser';

export interface ActivateAgentWorkflowData {
  agent_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  active: boolean;
  status: string | null;
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

export function extractActivateAgentWorkflowData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ActivateAgentWorkflowData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: ActivateAgentWorkflowData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    agent_id: null,
    workflow_id: null,
    workflow_name: null,
    active: false,
    status: null,
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
              workflow_id: args.workflow_id || output.workflow_id || null,
              workflow_name: output.workflow_name || null,
              active: args.active || false,
              status: output.status || null,
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
            workflow_id: args.workflow_id || toolOutput.workflow_id || null,
            workflow_name: toolOutput.workflow_name || null,
            active: args.active || false,
            status: toolOutput.status || null,
            actualIsSuccess: true
          };
        }
      }
    }

    return defaultResult;
  } catch (error) {
    console.error('Error extracting activate agent workflow data:', error);
    return defaultResult;
  }
} 