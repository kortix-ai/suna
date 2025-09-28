import { extractToolData, normalizeContentToString } from '../utils';

export interface ExposePortData {
  port: number | null;
  url: string | null;
  message: string | null;
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

const extractFromNewFormat = (content: any): { 
  port: number | null; 
  url: string | null;
  message: string | null;
  success?: boolean; 
  timestamp?: string;
} => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { port: null, url: null, message: null, success: undefined, timestamp: undefined };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    const args = toolExecution.arguments || {};
    
    let parsedOutput = toolExecution.result?.output;
    if (typeof parsedOutput === 'string') {
      try {
        parsedOutput = JSON.parse(parsedOutput);
      } catch (e) {
      }
    }

    const extractedData = {
      port: args.port ? parseInt(args.port, 10) : (parsedOutput?.port ? parseInt(parsedOutput.port, 10) : null),
      url: parsedOutput?.url || null,
      message: parsedOutput?.message || parsedContent.summary || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
    
    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { port: null, url: null, message: null, success: undefined, timestamp: undefined };
};

const extractPortFromAssistantContent = (content: string | object | undefined | null): number | null => {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;
  
  try {
    const match = contentStr.match(/<expose-port>\s*(\d+)\s*<\/expose-port>/);
    return match ? parseInt(match[1], 10) : null;
  } catch (e) {
    console.error('Failed to extract port number:', e);
    return null;
  }
};

const extractFromLegacyFormat = (content: any): { 
  port: number | null; 
  url: string | null;
  message: string | null;
} => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult && toolData.arguments) {
    return {
      port: toolData.arguments.port ? parseInt(toolData.arguments.port, 10) : null,
      url: null,
      message: null
    };
  }

  const contentStr = normalizeContentToString(content);
  if (!contentStr) {
    return { port: null, url: null, message: null };
  }
  try {
    const parsed = JSON.parse(contentStr);
    if (parsed.url && parsed.port) {
      return {
        port: parseInt(parsed.port, 10),
        url: parsed.url,
        message: parsed.message || null
      };
    }
  } catch (e) {
  }
  
  try {
    const toolResultMatch = contentStr.match(/ToolResult\(success=(?:True|true),\s*output='((?:[^'\\]|\\.)*)'\)/);
    if (toolResultMatch) {
      let jsonStr = toolResultMatch[1];
      
      jsonStr = jsonStr
        .replace(/\\\\n/g, '\n')
        .replace(/\\\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
      
      const result = JSON.parse(jsonStr);
      return {
        port: result.port ? parseInt(result.port, 10) : null,
        url: result.url || null,
        message: result.message || null
      };
    }
    
    const simpleMatch = contentStr.match(/output='([^']+)'/);
    if (simpleMatch) {
      const jsonStr = simpleMatch[1]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"');
      const result = JSON.parse(jsonStr);
      return {
        port: result.port ? parseInt(result.port, 10) : null,
        url: result.url || null,
        message: result.message || null
      };
    }
    
    return { port: null, url: null, message: null };
  } catch (e) {
    console.error('Failed to parse tool content:', e);
    console.error('Tool content was:', contentStr);
    return { port: null, url: null, message: null };
  }
};

export function extractExposePortData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  port: number | null;
  url: string | null;
  message: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let port: number | null = null;
  let url: string | null = null;
  let message: string | null = null;
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.port || assistantNewFormat.url || assistantNewFormat.message) {
    port = assistantNewFormat.port;
    url = assistantNewFormat.url;
    message = assistantNewFormat.message;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.port || toolNewFormat.url || toolNewFormat.message) {
    port = toolNewFormat.port;
    url = toolNewFormat.url;
    message = toolNewFormat.message;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else {
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    port = assistantLegacy.port || toolLegacy.port;
    url = assistantLegacy.url || toolLegacy.url;
    message = assistantLegacy.message || toolLegacy.message;
    
    if (!port) {
      const assistantPort = extractPortFromAssistantContent(assistantContent);
      if (assistantPort) {
        port = assistantPort;
      }
    }
  }

  return {
    port,
    url,
    message,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
} 