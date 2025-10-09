import { extractToolData } from '../utils';

export interface ExpandMessageData {
  messageId?: string;
  message?: string;
  status?: string;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
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

const extractFromNewFormat = (content: any): {
  messageId?: string;
  message?: string;
  status?: string;
  success?: boolean;
  timestamp?: string;
} => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return {};
  }

  // Handle new format with tool_execution
  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    const args = toolExecution.arguments || {};
    
    let parsedOutput = toolExecution.result?.output;
    if (typeof parsedOutput === 'string') {
      try {
        parsedOutput = JSON.parse(parsedOutput);
      } catch (e) {
        // Keep as string
      }
    }

    const extractedData: any = {
      messageId: args.message_id,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };

    // Extract message and status from output
    if (parsedOutput && typeof parsedOutput === 'object') {
      extractedData.status = parsedOutput.status;
      extractedData.message = parsedOutput.message || parsedOutput.content;
    } else if (typeof parsedOutput === 'string') {
      extractedData.message = parsedOutput;
    }
    
    return extractedData;
  }

  // Handle content wrapper
  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return {};
};

const extractFromLegacyFormat = (content: any): {
  messageId?: string;
  message?: string;
  status?: string;
} => {
  const toolData = extractToolData(content);
  
  if (toolData.arguments || toolData.toolResult) {
    const result: any = {
      messageId: toolData.arguments?.message_id
    };

    const output = toolData.toolResult?.toolOutput;
    if (output) {
      if (typeof output === 'object' && output !== null) {
        result.status = (output as any).status;
        result.message = (output as any).message || (output as any).content;
      } else if (typeof output === 'string') {
        try {
          const parsed = JSON.parse(output);
          result.status = parsed.status;
          result.message = parsed.message || parsed.content;
        } catch {
          result.message = output;
        }
      }
    }
    
    return result;
  }

  return {};
};

export function extractExpandMessageData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ExpandMessageData {
  let messageId: string | undefined;
  let message: string | undefined;
  let status: string | undefined;
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  const actualAssistantTimestamp = assistantTimestamp;

  // Try new format first
  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  // Extract from assistant content (parameters)
  if (assistantNewFormat.messageId) {
    messageId = assistantNewFormat.messageId;
  }

  // Extract from tool result (output)
  if (toolNewFormat.message || toolNewFormat.status) {
    message = toolNewFormat.message;
    status = toolNewFormat.status;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else {
    // Try legacy format
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    messageId = messageId || assistantLegacy.messageId || toolLegacy.messageId;
    message = toolLegacy.message;
    status = toolLegacy.status;
  }

  return {
    messageId,
    message,
    status,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}

