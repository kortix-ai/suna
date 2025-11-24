export interface TriggerData {
  provider: string;
  slug: string;
  is_active: boolean;
}

export interface CreateEventTriggerData {
  slug: string | null;
  profile_id: string | null;
  connected_account_id: string | null;
  trigger_config: Record<string, any> | null;
  name: string | null;
  agent_prompt: string | null;
  message: string | null;
  trigger: TriggerData | null;
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

export function extractCreateEventTriggerData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): CreateEventTriggerData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: CreateEventTriggerData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    slug: null,
    profile_id: null,
    connected_account_id: null,
    trigger_config: null,
    name: null,
    agent_prompt: null,
    message: null,
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

          if (args && output) {
            return {
              ...defaultResult,
              slug: args.slug || null,
              profile_id: args.profile_id || null,
              connected_account_id: args.connected_account_id || null,
              trigger_config: args.trigger_config || null,
              name: args.name || null,
              agent_prompt: args.agent_prompt || null,
              message: output.message || null,
              trigger: output.trigger || null,
              actualIsSuccess: true
            };
          }
        }
      }

      if (content && typeof content === 'object' && content.tool === 'create-event-trigger') {
        const parameters = content.parameters;
        const output = content.output;
        
        if (parameters && output) {
          return {
            ...defaultResult,
            slug: parameters.slug || null,
            profile_id: parameters.profile_id || null,
            connected_account_id: parameters.connected_account_id || null,
            trigger_config: parameters.trigger_config || null,
            name: parameters.name || null,
            agent_prompt: parameters.agent_prompt || null,
            message: output.message || null,
            trigger: output.trigger || null,
            actualIsSuccess: output.success !== false
          };
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
