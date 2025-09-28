import { parseToolResult } from '../tool-result-parser';

export interface CreateAgentScheduledTriggerData {
  agent_id: string | null;
  name: string | null;
  description?: string | null;
  cron_expression: string | null;
  execution_type: string | null;
  workflow_id?: string | null;
  workflow_input?: Record<string, any> | null;
  agent_prompt?: string | null;
  trigger: {
    id: string;
    agent_id: string;
    name: string;
    description?: string;
    cron_expression: string;
    execution_type: string;
    is_active: boolean;
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

export function extractCreateAgentScheduledTriggerData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): CreateAgentScheduledTriggerData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: CreateAgentScheduledTriggerData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    agent_id: null,
    name: null,
    description: null,
    cron_expression: null,
    execution_type: null,
    workflow_id: null,
    workflow_input: null,
    agent_prompt: null,
    trigger: null,
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

          if (args && output?.trigger) {
            return {
              ...defaultResult,
              agent_id: args.agent_id || null,
              name: args.name || null,
              description: args.description || null,
              cron_expression: args.cron_expression || null,
              execution_type: args.execution_type || null,
              workflow_id: args.workflow_id || null,
              workflow_input: args.workflow_input || null,
              agent_prompt: args.agent_prompt || null,
              trigger: output.trigger,
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

        if (args && toolOutput?.trigger) {
          return {
            ...defaultResult,
            agent_id: args.agent_id || null,
            name: args.name || null,
            description: args.description || null,
            cron_expression: args.cron_expression || null,
            execution_type: args.execution_type || null,
            workflow_id: args.workflow_id || null,
            workflow_input: args.workflow_input || null,
            agent_prompt: args.agent_prompt || null,
            trigger: toolOutput.trigger,
            actualIsSuccess: true
          };
        }
      }
    }

    return defaultResult;
  } catch (error) {
    console.error('Error extracting create agent scheduled trigger data:', error);
    return defaultResult;
  }
} 