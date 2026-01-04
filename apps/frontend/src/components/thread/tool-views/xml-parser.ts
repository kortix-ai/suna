/**
 * XML Tool Parser for new format
 * 
 * Parses tool calls in the format:
 * <function_calls>
 * <invoke name="tool_name">
 * <parameter name="param">value</parameter>
 * </invoke>
 * </function_calls>
 */

export interface ParsedToolCall {
  functionName: string;
  parameters: Record<string, any>;
  rawXml: string;
}


export function parseXmlToolCalls(content: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];

  const functionCallsRegex = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
  let functionCallsMatch;
  
  while ((functionCallsMatch = functionCallsRegex.exec(content)) !== null) {
    const functionCallsContent = functionCallsMatch[1];
    
    const invokeRegex = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi;
    let invokeMatch;
    
    while ((invokeMatch = invokeRegex.exec(functionCallsContent)) !== null) {
      const functionName = invokeMatch[1].replace(/_/g, '-');
      const invokeContent = invokeMatch[2];
      const parameters: Record<string, any> = {};
      
      const paramRegex = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
      let paramMatch;
      
      while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
        const paramName = paramMatch[1];
        const paramValue = paramMatch[2].trim();
        
        parameters[paramName] = parseParameterValue(paramValue);
      }
      
      toolCalls.push({
        functionName,
        parameters,
        rawXml: invokeMatch[0]
      });
    }
  }
  
  return toolCalls;
}

function parseParameterValue(value: string): any {
  const trimmed = value.trim();
  
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
    }
  }
  
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = parseFloat(trimmed);
    if (!isNaN(num)) return num;
  }
  
  return value;
}

export function extractToolName(content: string): string | null {
  if (isNewXmlFormat(content)) {
    const toolCalls = parseXmlToolCalls(content);
    if (toolCalls.length > 0) {
      return toolCalls[0].functionName.replace(/_/g, '-');
    }
  }
  
  const xmlRegex = /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/;
  const match = content.match(xmlRegex);
  if (match) {
    const toolName = match[1] || match[2];
    return toolName.replace(/_/g, '-');
  }
  
  return null;
}

export function isNewXmlFormat(content: string): boolean {
  return /<function_calls>[\s\S]*<invoke\s+name=/.test(content);
}

export function extractToolNameFromStream(content: string): string | null {
  const invokeMatch = content.match(/<invoke\s+name=["']([^"']+)["']/i);
  if (invokeMatch) {
    return invokeMatch[1].replace(/_/g, '-');
  }

  const oldFormatMatch = content.match(/<([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?!\/)/);
  if (oldFormatMatch) {
    return oldFormatMatch[1].replace(/_/g, '-');
  }
  
  return null;
}

export function formatToolNameForDisplay(toolName: string): string {
  if (toolName.startsWith('mcp_')) {
    const parts = toolName.split('_');
    if (parts.length >= 3) {
      const serverName = parts[1];
      const toolNamePart = parts.slice(2).join('_');
      const formattedServerName = serverName.charAt(0).toUpperCase() + serverName.slice(1);
      
      let formattedToolName = toolNamePart;
      if (toolNamePart.includes('-')) {
        formattedToolName = toolNamePart
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      } else if (toolNamePart.includes('_')) {
        formattedToolName = toolNamePart
          .split('_')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      } else {
        formattedToolName = toolNamePart.charAt(0).toUpperCase() + toolNamePart.slice(1);
      }
      
      return `${formattedServerName}: ${formattedToolName}`;
    }
  }
  
  return toolName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
} 