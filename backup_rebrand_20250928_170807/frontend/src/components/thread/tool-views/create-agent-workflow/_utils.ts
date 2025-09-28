import { parseToolResult } from '../tool-result-parser';

export interface CreateAgentWorkflowData {
  agent_id: string | null;
  name: string | null;
  template: string | null;
  variables: Array<{
    key: string;
    label: string;
    required: boolean;
  }> | null;
  description?: string | null;
  is_default: boolean;
  workflow: {
    id: string;
    agent_id: string;
    name: string;
    description?: string;
    is_default: boolean;
    status: string;
    steps_count: number;
    variables_count: number;
    created_at: string;
  } | null;
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

export function extractCreateAgentWorkflowData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): CreateAgentWorkflowData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: CreateAgentWorkflowData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    agent_id: null,
    name: null,
    template: null,
    variables: null,
    description: null,
    is_default: false,
    workflow: null,
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

          if (args && output?.workflow) {
            return {
              ...defaultResult,
              agent_id: args.agent_id || null,
              name: args.name || null,
              template: args.template || null,
              variables: args.variables || null,
              description: args.description || null,
              is_default: args.is_default || false,
              workflow: output.workflow,
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

        if (args && toolOutput?.workflow) {
          return {
            ...defaultResult,
            agent_id: args.agent_id || null,
            name: args.name || null,
            template: args.template || null,
            variables: args.variables || null,
            description: args.description || null,
            is_default: args.is_default || false,
            workflow: toolOutput.workflow,
            actualIsSuccess: true
          };
        }
      }
    }

    return defaultResult;
  } catch (error) {
    console.error('Error extracting create agent workflow data:', error);
    return defaultResult;
  }
} 