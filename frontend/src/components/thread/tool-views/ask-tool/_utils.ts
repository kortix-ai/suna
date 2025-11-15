import { extractToolData, normalizeContentToString } from '../utils';

export interface AskData {
  text: string | null;
  attachments: string[] | null;
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

const extractFromNewFormat = (content: any): { 
  text: string | null;
  attachments: string[] | null;
  status: string | null;
  success?: boolean; 
  timestamp?: string;
} => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { text: null, attachments: null, status: null, success: undefined, timestamp: undefined };
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

    let attachments: string[] | null = null;
    if (args.attachments) {
      if (typeof args.attachments === 'string') {
        attachments = args.attachments.split(',').map((a: string) => a.trim()).filter((a: string) => a.length > 0);
      } else if (Array.isArray(args.attachments)) {
        attachments = args.attachments;
      }
    }

    let status: string | null = null;
    if (parsedOutput && typeof parsedOutput === 'object' && parsedOutput.status) {
      status = parsedOutput.status;
    }

    const extractedData = {
      text: args.text || null,
      attachments,
      status: status || parsedContent.summary || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
    
    return extractedData;
  }

  // Handle native tool format: {"role": "tool", "content": "..."}
  if ('role' in parsedContent && parsedContent.role === 'tool' && 'content' in parsedContent) {
    const toolContent = parsedContent.content;
    if (typeof toolContent === 'string') {
      // Try to parse the content as JSON to extract structured data
      try {
        const innerParsed = JSON.parse(toolContent);
        if (innerParsed && typeof innerParsed === 'object') {
          return extractFromNewFormat(innerParsed);
        }
      } catch {
        // Not JSON, treat as plain text
        return {
          text: toolContent,
          attachments: null,
          status: null,
          success: parsedContent.success !== false,
          timestamp: undefined
        };
      }
    } else if (typeof toolContent === 'object' && toolContent !== null) {
      return extractFromNewFormat(toolContent);
    }
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { text: null, attachments: null, status: null, success: undefined, timestamp: undefined };
};

const extractFromLegacyFormat = (content: any): { 
  text: string | null;
  attachments: string[] | null;
  status: string | null;
} => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult && toolData.arguments) {
    let attachments: string[] | null = null;
    if (toolData.arguments.attachments) {
      if (Array.isArray(toolData.arguments.attachments)) {
        attachments = toolData.arguments.attachments;
      } else if (typeof toolData.arguments.attachments === 'string') {
        attachments = toolData.arguments.attachments.split(',').map(a => a.trim()).filter(a => a.length > 0);
      }
    }
    
    return {
      text: toolData.arguments.text || null,
      attachments,
      status: null
    };
  }

  const contentStr = normalizeContentToString(content);
  if (!contentStr) {
    return { text: null, attachments: null, status: null };
  }

  let attachments: string[] | null = null;
  const attachmentsMatch = contentStr.match(/attachments=["']([^"']*)["']/i);
  if (attachmentsMatch) {
    attachments = attachmentsMatch[1].split(',').map(a => a.trim()).filter(a => a.length > 0);
  }

  let text: string | null = null;
  const textMatch = contentStr.match(/<ask[^>]*>([^<]*)<\/ask>/i);
  if (textMatch) {
    text = textMatch[1].trim();
  }
  
  return {
    text,
    attachments,
    status: null
  };
};

export function extractAskData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  text: string | null;
  attachments: string[] | null;
  status: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let text: string | null = null;
  let attachments: string[] | null = null;
  let status: string | null = null;
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.text || assistantNewFormat.attachments || assistantNewFormat.status) {
    text = assistantNewFormat.text;
    attachments = assistantNewFormat.attachments;
    status = assistantNewFormat.status;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.text || toolNewFormat.attachments || toolNewFormat.status) {
    text = toolNewFormat.text;
    attachments = toolNewFormat.attachments;
    status = toolNewFormat.status;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else {
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    text = assistantLegacy.text || toolLegacy.text;
    attachments = assistantLegacy.attachments || toolLegacy.attachments;
    status = assistantLegacy.status || toolLegacy.status;
  }

  // Enhanced extraction: Try to extract from raw toolContent if still no data
  if (!text && !attachments && !status && toolContent) {
    try {
      // Handle native tool format directly
      if (typeof toolContent === 'string') {
        const parsed = JSON.parse(toolContent);
        if (parsed && typeof parsed === 'object' && parsed.role === 'tool' && parsed.content) {
          const content = parsed.content;
          if (typeof content === 'string') {
            // Try to parse nested content
            try {
              const innerParsed = JSON.parse(content);
              if (innerParsed && typeof innerParsed === 'object') {
                const nestedExtract = extractFromNewFormat(innerParsed);
                if (nestedExtract.text || nestedExtract.attachments) {
                  text = nestedExtract.text || text;
                  attachments = nestedExtract.attachments || attachments;
                  status = nestedExtract.status || status;
                }
              }
            } catch {
              // Use as plain text
              text = content;
            }
          } else if (typeof content === 'object') {
            const nestedExtract = extractFromNewFormat(content);
            if (nestedExtract.text || nestedExtract.attachments) {
              text = nestedExtract.text || text;
              attachments = nestedExtract.attachments || attachments;
              status = nestedExtract.status || status;
            }
          }
        }
      } else if (typeof toolContent === 'object' && toolContent !== null) {
        const obj = toolContent as any;
        if (obj.role === 'tool' && obj.content) {
          const content = obj.content;
          if (typeof content === 'string') {
            text = content;
          } else if (typeof content === 'object') {
            const nestedExtract = extractFromNewFormat(content);
            if (nestedExtract.text || nestedExtract.attachments) {
              text = nestedExtract.text || text;
              attachments = nestedExtract.attachments || attachments;
              status = nestedExtract.status || status;
            }
          }
        }
      }
    } catch (e) {
      // If parsing fails, continue with what we have
    }
  }
  
  return {
    text,
    attachments,
    status,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
} 