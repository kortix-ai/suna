import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface WebScrapeData {
  url: string | null;
  files: string[];
  message: string | null;
  urlCount: number;
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

export function extractWebScrapeData(toolData: ParsedToolData): WebScrapeData {
  const { arguments: args, result } = toolData;
  
  let url: string | null = null;
  let files: string[] = [];
  let message: string | null = null;
  let urlCount = 0;
  
  if (args?.urls) {
    if (typeof args.urls === 'string') {
      const urlsArray = args.urls.split(',').map((u: string) => u.trim());
      url = urlsArray[0] || null;
    } else if (Array.isArray(args.urls)) {
      url = args.urls[0] || null;
    }
  }
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? result.output 
      : JSON.stringify(result.output);
    
    message = output;
    
    const successMatch = output.match(/Successfully scraped (?:all )?(\d+) URLs?/);
    urlCount = successMatch ? parseInt(successMatch[1]) : 0;
    
    const fileMatches = output.match(/- ([^\n]+\.json)/g);
    files = fileMatches ? fileMatches.map((match: string) => match.replace('- ', '')) : [];
  }
  
  return {
    url,
    files,
    message,
    urlCount,
    success: result.success ?? true
  };
}

export function formatFileInfo(filePath: string) {
  const timestampMatch = filePath.match(/(\d{8}_\d{6})/);
  const fileName = filePath.split('/').pop() || filePath;
  
  return {
    timestamp: timestampMatch ? timestampMatch[1] : '',
    fileName,
    fullPath: filePath
  };
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

