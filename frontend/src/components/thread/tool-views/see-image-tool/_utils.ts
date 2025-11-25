import { ToolCallData, ToolResultData } from '../types';
import { normalizeContentToString } from '../utils';

export interface SeeImageData {
  filePath: string | null;
  description: string | null;
  success?: boolean;
  timestamp?: string;
  output?: string;
}


function cleanImagePath(path: string): string {
  if (!path) return path;

  return path
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .split('\n')[0]
    .trim();
}

function extractImageFilePath(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;
  
  try {
    const parsedContent = JSON.parse(contentStr);
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      const nestedContentStr = parsedContent.content;
      let filePathMatch = nestedContentStr.match(/<load-image\s+file_path=["']([^"']+)["'][^>]*><\/load-image>/i);
      if (filePathMatch) {
        return cleanImagePath(filePathMatch[1]);
      }
      filePathMatch = nestedContentStr.match(/<load-image[^>]*>([^<]+)<\/load-image>/i);
      if (filePathMatch) {
        return cleanImagePath(filePathMatch[1]);
      }
    }
  } catch (e) {
  }
  
  let filePathMatch = contentStr.match(/<load-image\s+file_path=["']([^"']+)["'][^>]*><\/load-image>/i);
  if (filePathMatch) {
    return cleanImagePath(filePathMatch[1]);
  }
  filePathMatch = contentStr.match(/<load-image[^>]*>([^<]+)<\/load-image>/i);
  if (filePathMatch) {
    return cleanImagePath(filePathMatch[1]);
  }

  const embeddedFileMatch = contentStr.match(/image\s*:\s*["']?([^,"'\s]+\.(jpg|jpeg|png|gif|svg|webp))["']?/i);
  if (embeddedFileMatch) {
    return cleanImagePath(embeddedFileMatch[1]);
  }

  const extensionMatch = contentStr.match(/["']?([^,"'\s]+\.(jpg|jpeg|png|gif|svg|webp))["']?/i);
  if (extensionMatch) {
    return cleanImagePath(extensionMatch[1]);
  }
  return null;
}

function extractImageDescription(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;
  
  try {
    const parsedContent = JSON.parse(contentStr);
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      const parts = parsedContent.content.split(/<load-image/i);
      if (parts.length > 1) {
        return parts[0].trim();
      }
    }
  } catch (e) {
  }

  const parts = contentStr.split(/<load-image/i);
  if (parts.length > 1) {
    return parts[0].trim();
  }

  return null;
}

function parseToolResult(content: string | object | undefined | null): { success: boolean; message: string; filePath?: string } {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return { success: false, message: 'No tool result available' };
  
  try {
    let contentToProcess = contentStr;
    
    try {
      const parsedContent = JSON.parse(contentStr);
      if (parsedContent.content && typeof parsedContent.content === 'string') {
        contentToProcess = parsedContent.content;
      }
    } catch (e) {
    }

    const toolResultPattern = /<tool_result>\s*<load-image>\s*ToolResult\(([^)]+)\)\s*<\/load-image>\s*<\/tool_result>/;
    const toolResultMatch = contentToProcess.match(toolResultPattern);
    
    if (toolResultMatch) {
      const resultStr = toolResultMatch[1];
      const success = resultStr.includes('success=True');
      
      const outputMatch = resultStr.match(/output="([^"]+)"/);
      const message = outputMatch ? outputMatch[1] : '';

      let filePath;
      if (success && message) {
        const filePathMatch = message.match(/Successfully loaded the image ['"]([^'"]+)['"]/i);
        if (filePathMatch && filePathMatch[1]) {
          filePath = filePathMatch[1];
        }
      }
      
      return { success, message, filePath };
    }
    
    const directToolResultMatch = contentToProcess.match(/<tool_result>\s*<load-image>\s*([^<]+)<\/load-image>\s*<\/tool_result>/);
    if (directToolResultMatch) {
      const resultContent = directToolResultMatch[1];
      const success = resultContent.includes('success=True') || resultContent.includes('Successfully');
      
      const filePathMatch = resultContent.match(/['"]([^'"]+\.(jpg|jpeg|png|gif|webp|svg))['"]/) ||
                           resultContent.match(/Successfully loaded the image ['"]([^'"]+)['"]/i);
      
      const filePath = filePathMatch ? filePathMatch[1] : undefined;
      
      return { 
        success, 
        message: success ? 'Image loaded successfully' : 'Failed to load image',
        filePath 
      };
    }
    
    if (contentToProcess.includes('success=True') || contentToProcess.includes('Successfully')) {
      const filePathMatch = contentToProcess.match(/Successfully loaded the image ['"]([^'"]+)['"]/i);
      const filePath = filePathMatch ? filePathMatch[1] : undefined;
      
      return { success: true, message: 'Image loaded successfully', filePath };
    }
    
    if (contentToProcess.includes('success=False') || contentToProcess.includes('Failed')) {
      return { success: false, message: 'Failed to load image' };
    }
  } catch (e) {
    console.error('Error parsing tool result:', e);
    return { success: false, message: 'Failed to parse tool result' };
  }
  return { success: true, message: 'Image loaded' };
}

export function extractSeeImageData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  filePath: string | null;
  description: string | null;
  output: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  // Extract from toolCall arguments
  const args = toolCall.arguments || {};
  let filePath: string | null = args.file_path || null;
  let description: string | null = args.description || null;
  let output: string | null = null;

  // Extract from toolResult
  if (toolResult?.output) {
    const outputData = toolResult.output;
    if (typeof outputData === 'string') {
      output = outputData;
      // Try to extract file path from output message
      const filePathMatch = outputData.match(/Successfully loaded the image ['"]([^'"]+)['"]/i);
      if (filePathMatch && !filePath) {
        filePath = filePathMatch[1];
      }
    } else if (typeof outputData === 'object' && outputData !== null) {
      filePath = filePath || (outputData as any).file_path || (outputData as any).display_file_path || null;
      description = description || (outputData as any).description || null;
      output = (outputData as any).message || JSON.stringify(outputData);
    }
  }

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    filePath,
    description,
    output,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
} 


export function constructImageUrl(filePath: string, project?: { sandbox?: { sandbox_url?: string; workspace_path?: string; id?: string } }): string {
  if (!filePath || filePath === 'STREAMING') {
    console.error('Invalid image path:', filePath);
    return '';
  }

  const cleanPath = filePath.replace(/^['"](.*)['"]$/, '$1');
  
  // Check if it's a URL first, before trying to construct sandbox paths
  if (cleanPath.startsWith('http')) {
    return cleanPath;
  }
  
  // PREFER backend API (requires authentication but more reliable)
  const sandboxId = typeof project?.sandbox === 'string' 
    ? project.sandbox 
    : project?.sandbox?.id;
  
  if (sandboxId) {
    let normalizedPath = cleanPath;
    if (!normalizedPath.startsWith('/workspace')) {
      normalizedPath = `/workspace/${normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath}`;
    }
    
    const apiEndpoint = `${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(normalizedPath)}`;
    return apiEndpoint;
  }
  
  // Fallback to sandbox_url for direct access
  if (project?.sandbox?.sandbox_url) {
    const sandboxUrl = project.sandbox.sandbox_url.replace(/\/$/, '');
    let normalizedPath = cleanPath;
    if (!normalizedPath.startsWith('/workspace')) {
      normalizedPath = `/workspace/${normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath}`;
    }
    
    const fullUrl = `${sandboxUrl}${normalizedPath}`;
    return fullUrl;
  }
  
  console.warn('No sandbox URL or ID available, using path as-is:', cleanPath);
  return cleanPath;
}