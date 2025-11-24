export interface CreateAgentScheduledTriggerData {
  agent_id: string | null;
  name: string | null;
  description?: string | null;
  cron_expression: string | null;
  agent_prompt?: string | null;
  trigger: {
    id: string;
    agent_id: string;
    name: string;
    description?: string;
    cron_expression: string;
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
          // Keep original content if parsing fails
        }
      }

      if (content && typeof content === 'object' && content.content) {
        try {
          const nestedContent = typeof content.content === 'string' ? JSON.parse(content.content) : content.content;
          content = nestedContent;
        } catch (e) {
          // Keep original content if parsing fails
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
              agent_prompt: args.agent_prompt || null,
              trigger: output.trigger,
              actualIsSuccess: true
            };
          }
        }
      }
    }

    if (assistantContent) {
      // Handle assistant content if needed
    }

    return defaultResult;
  } catch (error) {
    return defaultResult;
  }
} 