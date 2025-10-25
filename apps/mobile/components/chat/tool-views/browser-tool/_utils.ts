import type { ParsedToolData } from '@/lib/utils/tool-parser';
import type { UnifiedMessage } from '@/api/types';

export interface BrowserData {
  url: string | null;
  operation: string;
  screenshotUrl: string | null;
  screenshotBase64: string | null;
  messageId: string | null;
  parameters: Record<string, any> | null;
  result: Record<string, any> | null;
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

export function extractBrowserUrl(content: string | undefined): string | null {
  if (!content) return null;

  const urlMatch = content.match(/(?:url|URL)["']?\s*[:=]\s*["']?([^"'\s,}]+)/);
  if (urlMatch) return urlMatch[1];

  const httpMatch = content.match(/https?:\/\/[^\s"']+/);
  if (httpMatch) return httpMatch[0];

  return null;
}

export function getBrowserOperation(toolName: string): string {
  const operations: Record<string, string> = {
    'browser-navigate-to': 'Navigate',
    'browser-click-element': 'Click Element',
    'browser-input-text': 'Input Text',
    'browser-scroll-down': 'Scroll Down',
    'browser-scroll-up': 'Scroll Up',
    'browser-go-back': 'Go Back',
    'browser-wait': 'Wait',
    'browser-send-keys': 'Send Keys',
    'browser-switch-tab': 'Switch Tab',
    'browser-close-tab': 'Close Tab',
    'browser-scroll-to-text': 'Scroll to Text',
    'browser-get-dropdown-options': 'Get Dropdown Options',
    'browser-select-dropdown-option': 'Select Option',
    'browser-drag-drop': 'Drag & Drop',
    'browser-click-coordinates': 'Click Coordinates',
  };

  return operations[toolName] || 'Browser Action';
}

export function extractBrowserData(
  toolData: ParsedToolData,
  toolMessage: UnifiedMessage,
  assistantMessage: UnifiedMessage | null
): BrowserData {
  const { arguments: args, result, toolName } = toolData;
  
  let url = args?.url || null;
  let screenshotUrl: string | null = null;
  let screenshotBase64: string | null = null;
  let messageId: string | null = null;
  let parameters: Record<string, any> | null = args || null;
  let resultData: Record<string, any> | null = null;

  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    screenshotUrl = output?.image_url || null;
    messageId = output?.message_id || null;
    
    if (output && typeof output === 'object') {
      resultData = Object.fromEntries(
        Object.entries(output).filter(([k]) => k !== 'message_id')
      );
    }
  }

  const content = toolMessage.content;
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      const innerContent = parsed?.content || content;
      
      if (typeof innerContent === 'string') {
        const toolResultMatch = innerContent.match(/ToolResult\([^)]*output='([\s\S]*?)'(?:\s*,|\s*\))/);
        if (toolResultMatch) {
          const outputString = toolResultMatch[1];
          try {
            const cleanedOutput = outputString
              .replace(/\\n/g, '\n')
              .replace(/\\"/g, '"')
              .replace(/\\u([0-9a-fA-F]{4})/g, (_match, grp) => 
                String.fromCharCode(parseInt(grp, 16))
              );
            const outputJson = JSON.parse(cleanedOutput);

            if (outputJson.image_url) screenshotUrl = outputJson.image_url;
            if (outputJson.message_id) messageId = outputJson.message_id;
          } catch (e) {}
        }

        if (!screenshotUrl) {
          const imageUrlMatch = innerContent.match(/"image_url":\s*"([^"]+)"/);
          if (imageUrlMatch) screenshotUrl = imageUrlMatch[1];
        }

        if (!messageId) {
          const messageIdMatch = innerContent.match(/"message_id":\s*"([^"]+)"/);
          if (messageIdMatch) messageId = messageIdMatch[1];
        }
      }
    } catch (e) {}
  }

  if (!url && assistantMessage?.content) {
    url = extractBrowserUrl(assistantMessage.content);
  }

  const operation = getBrowserOperation(toolName);

  return {
    url,
    operation,
    screenshotUrl,
    screenshotBase64,
    messageId,
    parameters,
    result: resultData
  };
}

