import { ToolCallData, ToolResultData } from '../types';
import { normalizeContentToString } from '../utils';

export interface WebScrapeData {
  url: string | null;
  urls: string[] | null;
  success?: boolean;
  message: string | null;
  files: string[];
  urlCount: number;
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
  url: string | null;
  urls: string[] | null;
  success?: boolean; 
  message: string | null;
  files: string[];
  urlCount: number;
  timestamp?: string;
} => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { url: null, urls: null, success: undefined, message: null, files: [], urlCount: 0, timestamp: undefined };
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

    let urls: string[] | null = null;
    let url: string | null = null;
    
    if (args.urls) {
      if (typeof args.urls === 'string') {
        urls = args.urls.split(',').map((u: string) => u.trim());
        url = urls?.[0] || null;
      } else if (Array.isArray(args.urls)) {
        urls = args.urls;
        url = urls?.[0] || null;
      }
    }

    let files: string[] = [];
    let urlCount = 0;
    let message = '';

    if (typeof toolExecution.result?.output === 'string') {
      const outputStr = toolExecution.result.output;
      message = outputStr;
      
      const successMatch = outputStr.match(/Successfully scraped (?:all )?(\d+) URLs?/);
      urlCount = successMatch ? parseInt(successMatch[1]) : 0;
      
      const fileMatches = outputStr.match(/- ([^\n]+\.json)/g);
      files = fileMatches ? fileMatches.map((match: string) => match.replace('- ', '')) : [];
    }

    const extractedData = {
      url,
      urls,
      success: toolExecution.result?.success,
      message: message || parsedContent.summary || null,
      files,
      urlCount,
      timestamp: toolExecution.execution_details?.timestamp
    };
    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { url: null, urls: null, success: undefined, message: null, files: [], urlCount: 0, timestamp: undefined };
};

const extractScrapeUrl = (content: string | object | undefined | null): string | null => {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;
  
  const urlMatch = contentStr.match(/<scrape-webpage[^>]*\s+urls=["']([^"']+)["']/);
  if (urlMatch) {
    return urlMatch[1];
  }
  
  const httpMatch = contentStr.match(/https?:\/\/[^\s<>"]+/);
  return httpMatch ? httpMatch[0] : null;
};

const extractScrapeResults = (content: string | object | undefined | null): { 
  success: boolean; 
  message: string; 
  files: string[]; 
  urlCount: number;
} => {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return { success: false, message: 'No output received', files: [], urlCount: 0 };
  
  const outputMatch = contentStr.match(/output='([^']+)'/);
  const cleanContent = outputMatch ? outputMatch[1].replace(/\\n/g, '\n') : contentStr;
  
  const successMatch = cleanContent.match(/Successfully scraped (?:all )?(\d+) URLs?/);
  const urlCount = successMatch ? parseInt(successMatch[1]) : 0;
  
  const fileMatches = cleanContent.match(/- ([^\n]+\.json)/g);
  const files = fileMatches ? fileMatches.map(match => match.replace('- ', '')) : [];
  
  const success = cleanContent.includes('Successfully scraped');
  
  return {
    success,
    message: cleanContent,
    files,
    urlCount
  };
};

const extractFromLegacyFormat = (content: any): { 
  url: string | null;
  urls: string[] | null;
  success?: boolean;
  message: string | null;
  files: string[];
  urlCount: number;
} => {
  // Legacy extraction removed - use toolCall/toolResult props instead

  const contentStr = normalizeContentToString(content);
  if (!contentStr) {
    return { url: null, urls: null, success: undefined, message: null, files: [], urlCount: 0 };
  }

  const url = extractScrapeUrl(contentStr);
  const results = extractScrapeResults(contentStr);
  
  return {
    url,
    urls: url ? [url] : null,
    success: results.success,
    message: results.message,
    files: results.files,
    urlCount: results.urlCount
  };
};

export function extractWebScrapeData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  url: string | null;
  urls: string[] | null;
  success: boolean;
  message: string | null;
  files: string[];
  urlCount: number;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  // Extract URL from toolCall arguments
  const args = toolCall.arguments || {};
  let url: string | null = null;
  let urls: string[] | null = null;

  if (args.urls) {
    if (typeof args.urls === 'string') {
      urls = args.urls.split(',').map((u: string) => u.trim());
      url = urls?.[0] || null;
    } else if (Array.isArray(args.urls)) {
      urls = args.urls;
      url = urls?.[0] || null;
    }
  } else if (args.url) {
    url = args.url;
    urls = [url];
  }

  // Extract results from toolResult
  let success = isSuccess;
  let message: string | null = null;
  let files: string[] = [];
  let urlCount = 0;

  if (toolResult?.output) {
    const output = toolResult.output;
    success = toolResult.success !== undefined ? toolResult.success : isSuccess;

    if (typeof output === 'string') {
      message = output;
      
      const successMatch = output.match(/Successfully scraped (?:all )?(\d+) URLs?/);
      urlCount = successMatch ? parseInt(successMatch[1]) : 0;
      
      const fileMatches = output.match(/- ([^\n]+\.json)/g);
      files = fileMatches ? fileMatches.map((match: string) => match.replace('- ', '')) : [];
    } else if (typeof output === 'object' && output !== null) {
      const outputObj = output as any;
      message = outputObj.message || JSON.stringify(output);
      
      if (outputObj.files && Array.isArray(outputObj.files)) {
        files = outputObj.files;
      }
      
      if (outputObj.url_count !== undefined) {
        urlCount = outputObj.url_count;
      } else if (outputObj.urls && Array.isArray(outputObj.urls)) {
        urlCount = outputObj.urls.length;
      }
    }
  }

  return {
    url,
    urls,
    success,
    message,
    files,
    urlCount,
    actualIsSuccess: success,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
} 