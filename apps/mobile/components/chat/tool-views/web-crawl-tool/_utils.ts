import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface WebCrawlData {
  url: string | null;
  content: string | null;
  success: boolean;
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

export function extractWebCrawlData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): WebCrawlData {
  const args = typeof toolCall.arguments === 'object' ? toolCall.arguments : JSON.parse(toolCall.arguments);
  
  let url = args?.url || null;
  let content: string | null = null;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    content = output?.text || output?.content || null;
    
    if (!url && output?.url) {
      url = output.url;
    }
  }
  
  return {
    url,
    content,
    success: toolResult?.success ?? true
  };
}

export function getContentStats(content: string | null) {
  if (!content || typeof content !== 'string') {
    return { wordCount: 0, charCount: 0, lineCount: 0 };
  }
  
  const wordCount = content.trim().split(/\s+/).length;
  const charCount = content.length;
  const lineCount = content.split('\n').length;
  
  return { wordCount, charCount, lineCount };
}

export function formatDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '');
  } catch (e) {
    return url;
  }
}

export function getFavicon(url: string): string | null {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  } catch (e) {
    return null;
  }
}

