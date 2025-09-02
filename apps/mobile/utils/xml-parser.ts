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
    } catch {}
  }
  
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = parseFloat(trimmed);
    if (!isNaN(num)) return num;
  }
  
  return value;
}

export function isNewXmlFormat(content: string): boolean {
  return /<function_calls>[\s\S]*<invoke\s+name=/.test(content);
}

export function extractToolNameFromStream(content: string): string | null {
  // Only match COMPLETE invoke patterns with proper closing quotes
  const invokeMatch = content.match(/<invoke\s+name=["']([^"']+)["']>/i);
  if (invokeMatch) {
    const toolName = invokeMatch[1].replace(/_/g, '-');
    return formatToolNameForDisplay(toolName);
  }

  // For old format, only match complete opening tags (with >)
  const oldFormatMatch = content.match(/<([a-zA-Z\-_]+)>/);
  if (oldFormatMatch) {
    const toolName = oldFormatMatch[1].replace(/_/g, '-');
    // Only show if it's a known tool to avoid false positives
    if (HIDE_STREAMING_XML_TAGS.has(toolName)) {
      return formatToolNameForDisplay(toolName);
    }
  }
  
  return null;
}

export function formatToolNameForDisplay(toolName: string): string {
  return toolName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const HIDE_STREAMING_XML_TAGS = new Set([
  'execute-command',
  'create-file',
  'delete-file',
  'full-file-rewrite',
  'str-replace',
  'web-search',
  'crawl-webpage',
  'ask',
  'complete',
]);

export function detectStreamingTag(streamingTextContent: string): { detectedTag: string | null, tagStartIndex: number } {
  let detectedTag: string | null = null;
  let tagStartIndex = -1;
  
  if (streamingTextContent) {
    // Check for complete function_calls opening tag
    const functionCallsIndex = streamingTextContent.indexOf('<function_calls>');
    if (functionCallsIndex !== -1) {
      detectedTag = 'function_calls';
      tagStartIndex = functionCallsIndex;
    } else {
      // Only detect complete opening tags to avoid partial matches
      for (const tag of HIDE_STREAMING_XML_TAGS) {
        const completeTagPattern = `<${tag}>`;
        const index = streamingTextContent.indexOf(completeTagPattern);
        if (index !== -1) {
          detectedTag = tag;
          tagStartIndex = index;
          break;
        }
      }
      
      // Also check for complete invoke patterns
      const invokePattern = /<invoke\s+name=["'][^"']+["']>/;
      const invokeMatch = streamingTextContent.match(invokePattern);
      if (invokeMatch && invokeMatch.index !== undefined) {
        detectedTag = 'function_calls';
        tagStartIndex = invokeMatch.index;
      }
    }
  }
  
  return { detectedTag, tagStartIndex };
} 