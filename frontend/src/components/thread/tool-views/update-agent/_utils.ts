import { parseToolResult } from '../tool-result-parser';

export interface UpdateAgentData {
  name: string | null;
  description?: string | null;
  system_prompt: string | null;
  agentpress_tools: Record<string, boolean> | null;
  configured_mcps?: any[] | null;
  is_default?: boolean;
  icon_name?: string | null;
  icon_color?: string | null;
  icon_background?: string | null;
  agent?: {
    agent_id: string;
    account_id: string;
    name: string;
    description?: string | null;
    is_default: boolean;
    created_at: string;
    updated_at: string;
    is_public: boolean;
    tags: string[];
    current_version_id: string;
    version_count: number;
    metadata: Record<string, any>;
    icon_name: string;
    icon_color: string;
    icon_background: string;
  } | null;
  updated_fields?: string[];
  version_created?: boolean;
  message?: string;
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

export function extractUpdateAgentData(
  assistantContent?: string,
  toolContent?: any,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): UpdateAgentData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: UpdateAgentData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    name: null,
    description: null,
    system_prompt: null,
    agentpress_tools: null,
    configured_mcps: null,
    is_default: false,
    icon_name: null,
    icon_color: null,
    icon_background: null,
    agent: null,
    updated_fields: [],
    version_created: false,
    message: null,
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
              name: args.name || null,
              description: args.description || null,
              system_prompt: args.system_prompt || null,
              agentpress_tools: args.agentpress_tools || null,
              configured_mcps: args.configured_mcps || null,
              is_default: args.is_default || false,
              icon_name: args.icon_name || null,
              icon_color: args.icon_color || null,
              icon_background: args.icon_background || null,
              agent: output.agent || null,
              updated_fields: output.updated_fields || [],
              version_created: output.version_created || false,
              message: output.message || null,
              actualIsSuccess: true
            };
          }
        }
      }

      if (content && typeof content === 'object' && content.tool === 'update-agent') {
        const parameters = content.parameters;
        const output = content.output;
        
        if (parameters && output) {
          return {
            ...defaultResult,
            name: parameters.name || null,
            description: parameters.description || null,
            system_prompt: parameters.system_prompt || null,
            agentpress_tools: parameters.agentpress_tools || null,
            configured_mcps: parameters.configured_mcps || null,
            is_default: parameters.is_default || false,
            icon_name: parameters.icon_name || null,
            icon_color: parameters.icon_color || null,
            icon_background: parameters.icon_background || null,
            agent: output.agent || null,
            updated_fields: output.updated_fields || [],
            version_created: output.version_created || false,
            message: output.message || null,
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
            name: args.name || null,
            description: args.description || null,
            system_prompt: args.system_prompt || null,
            agentpress_tools: args.agentpress_tools || null,
            configured_mcps: args.configured_mcps || null,
            is_default: args.is_default || false,
            icon_name: args.icon_name || null,
            icon_color: args.icon_color || null,
            icon_background: args.icon_background || null,
            agent: toolOutput.agent || null,
            updated_fields: toolOutput.updated_fields || [],
            version_created: toolOutput.version_created || false,
            message: toolOutput.message || null,
            actualIsSuccess: true
          };
        }
      }
    }

    return defaultResult;
  } catch (error) {
    console.error('Error extracting update agent data:', error);
    return defaultResult;
  }
}
