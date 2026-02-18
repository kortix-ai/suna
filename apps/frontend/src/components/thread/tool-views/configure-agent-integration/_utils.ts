export interface ConfigureAgentIntegrationData {
  agent_id: string | null;
  profile_name: string | null;
  enabled_tools: string[] | null;
  display_name: string | null;
  integration_name: string | null;
  enabled_tools_count: number;
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

export function extractConfigureAgentIntegrationData(
  assistantContent?: string,
  toolContent?: any,
  toolArguments?: Record<string, any>,
  isSuccess?: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ConfigureAgentIntegrationData & {
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
} {
  const defaultResult: ConfigureAgentIntegrationData & {
    actualIsSuccess: boolean;
    actualToolTimestamp: string | undefined;
    actualAssistantTimestamp: string | undefined;
  } = {
    agent_id: null,
    profile_name: null,
    enabled_tools: null,
    display_name: null,
    integration_name: null,
    enabled_tools_count: 0,
    actualIsSuccess: isSuccess || false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };

  const args = toolArguments || {};

  if (toolContent) {
    const parsedOutput = parseContent(toolContent);
    if (parsedOutput && typeof parsedOutput === 'object') {
      return {
        agent_id: args.agent_id || parsedOutput.agent_id || null,
        profile_name: args.profile_name || parsedOutput.profile_name || null,
        enabled_tools: args.enabled_tools || parsedOutput.enabled_tools || null,
        display_name: args.display_name || parsedOutput.display_name || null,
        integration_name: parsedOutput.integration_name || null,
        enabled_tools_count: parsedOutput.enabled_tools_count || (args.enabled_tools?.length || 0),
        success: isSuccess,
        timestamp: toolTimestamp,
        actualIsSuccess: isSuccess || false,
        actualToolTimestamp: toolTimestamp,
        actualAssistantTimestamp: assistantTimestamp
      };
    }
  }

  if (assistantContent) {
    const content = parseContent(assistantContent);
    if (content?.tool_execution?.result?.output) {
      const output = content.tool_execution.result.output;
      const legacyArgs = content.tool_execution?.arguments || args;
      
      return {
        agent_id: legacyArgs.agent_id || output.agent_id || null,
        profile_name: legacyArgs.profile_name || output.profile_name || null,
        enabled_tools: legacyArgs.enabled_tools || output.enabled_tools || null,
        display_name: legacyArgs.display_name || output.display_name || null,
        integration_name: output.integration_name || null,
        enabled_tools_count: output.enabled_tools_count || (legacyArgs.enabled_tools?.length || 0),
        success: content.tool_execution?.result?.success,
        timestamp: content.tool_execution?.execution_details?.timestamp,
        actualIsSuccess: content.tool_execution?.result?.success !== undefined ? content.tool_execution.result.success : (isSuccess || false),
        actualToolTimestamp: toolTimestamp,
        actualAssistantTimestamp: content.tool_execution?.execution_details?.timestamp || assistantTimestamp
      };
    }
  }

  return defaultResult;
} 
