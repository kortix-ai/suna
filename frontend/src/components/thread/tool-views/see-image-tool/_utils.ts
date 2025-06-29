import { extractToolData, normalizeContentToString } from '../utils';

export interface SeeImageData {
  filePath: string | null;
  description: string | null;
  success?: boolean;
  timestamp?: string;
  output?: string;
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
  filePath: string | null; 
  description: string | null;
  success?: boolean; 
  timestamp?: string;
  output?: string;
} => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { filePath: null, description: null, success: undefined, timestamp: undefined, output: undefined };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    const args = toolExecution.arguments || {};
    
    let parsedOutput = toolExecution.result?.output;
    if (typeof parsedOutput === 'string') {
      try {
        parsedOutput = JSON.parse(parsedOutput);
      } catch (e) {
        // Keep as string if parsing fails
      }
    }

    const extractedData = {
      filePath: args.file_path || null,
      description: parsedContent.summary || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp,
      output: typeof toolExecution.result?.output === 'string' ? toolExecution.result.output : null
    };

    console.log('SeeImageToolView: Extracted from new format:', {
      filePath: extractedData.filePath,
      hasDescription: !!extractedData.description,
      success: extractedData.success
    });
    
    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { filePath: null, description: null, success: undefined, timestamp: undefined, output: undefined };
};

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
  
  console.log('Extracting file path from content:', contentStr);
  
  try {
    const parsedContent = JSON.parse(contentStr);
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      const nestedContentStr = parsedContent.content;
      let filePathMatch = nestedContentStr.match(/<see-image\s+file_path=["']([^"']+)["'][^>]*><\/see-image>/i);
      if (filePathMatch) {
        return cleanImagePath(filePathMatch[1]);
      }
      filePathMatch = nestedContentStr.match(/<see-image[^>]*>([^<]+)<\/see-image>/i);
      if (filePathMatch) {
        return cleanImagePath(filePathMatch[1]);
      }
    }
  } catch (e) {
  }
  
  let filePathMatch = contentStr.match(/<see-image\s+file_path=["']([^"']+)["'][^>]*><\/see-image>/i);
  if (filePathMatch) {
    return cleanImagePath(filePathMatch[1]);
  }
  filePathMatch = contentStr.match(/<see-image[^>]*>([^<]+)<\/see-image>/i);
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

  console.log('No file path found in assistant content');
  return null;
}

function extractImageDescription(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;
  
  try {
    const parsedContent = JSON.parse(contentStr);
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      const parts = parsedContent.content.split(/<see-image/i);
      if (parts.length > 1) {
        return parts[0].trim();
      }
    }
  } catch (e) {
  }

  const parts = contentStr.split(/<see-image/i);
  if (parts.length > 1) {
    return parts[0].trim();
  }

  return null;
}

function parseToolResult(content: string | object | undefined | null): { success: boolean; message: string; filePath?: string } {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return { success: false, message: 'No tool result available' };
  
  console.log('Parsing tool result content:', contentStr);

  try {
    let contentToProcess = contentStr;
    
    try {
      const parsedContent = JSON.parse(contentStr);
      if (parsedContent.content && typeof parsedContent.content === 'string') {
        contentToProcess = parsedContent.content;
      }
    } catch (e) {
    }

    const toolResultPattern = /<tool_result>\s*<see-image>\s*ToolResult\(([^)]+)\)\s*<\/see-image>\s*<\/tool_result>/;
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
          console.log('Found file path in tool result:', filePath);
        }
      }
      
      return { success, message, filePath };
    }
    
    const directToolResultMatch = contentToProcess.match(/<tool_result>\s*<see-image>\s*([^<]+)<\/see-image>\s*<\/tool_result>/);
    if (directToolResultMatch) {
      const resultContent = directToolResultMatch[1];
      const success = resultContent.includes('success=True') || resultContent.includes('Successfully');
      
      const filePathMatch = resultContent.match(/['"]([^'"]+\.(jpg|jpeg|png|gif|webp|svg))['"]/) ||
                           resultContent.match(/Successfully loaded the image ['"]([^'"]+)['"]/i);
      
      const filePath = filePathMatch ? filePathMatch[1] : undefined;
      console.log('Found file path in direct tool result:', filePath);
      
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

const extractFromLegacyFormat = (content: any): { 
  filePath: string | null; 
  description: string | null;
} => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult && toolData.arguments) {
    console.log('SeeImageToolView: Extracted from legacy format (extractToolData):', {
      filePath: toolData.arguments.file_path
    });
    
    return {
      filePath: toolData.arguments.file_path || null,
      description: null
    };
  }

  const contentStr = normalizeContentToString(content);
  if (!contentStr) {
    return { filePath: null, description: null };
  }

  const filePath = extractImageFilePath(contentStr);
  const description = extractImageDescription(contentStr);
  
  console.log('SeeImageToolView: Extracted from legacy format (manual parsing):', {
    filePath,
    hasDescription: !!description
  });
  
  return { filePath, description };
};

export function extractSeeImageData(
  assistantContent: any,
  toolContent: any,
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
  let filePath: string | null = null;
  let description: string | null = null;
  let output: string | null = null;
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  console.log('SeeImageToolView: Format detection results:', {
    assistantNewFormat: {
      hasFilePath: !!assistantNewFormat.filePath,
      hasDescription: !!assistantNewFormat.description
    },
    toolNewFormat: {
      hasFilePath: !!toolNewFormat.filePath,
      hasDescription: !!toolNewFormat.description
    }
  });

  if (assistantNewFormat.filePath || assistantNewFormat.description) {
    filePath = assistantNewFormat.filePath;
    description = assistantNewFormat.description;
    output = assistantNewFormat.output;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
    console.log('SeeImageToolView: Using assistant new format data');
  } else if (toolNewFormat.filePath || toolNewFormat.description) {
    filePath = toolNewFormat.filePath;
    description = toolNewFormat.description;
    output = toolNewFormat.output;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
    console.log('SeeImageToolView: Using tool new format data');
  } else {
    // Fall back to legacy format parsing
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    filePath = assistantLegacy.filePath || toolLegacy.filePath;
    description = assistantLegacy.description || toolLegacy.description;
    
    // Also try the existing parseToolResult function for legacy compatibility
    const toolResult = parseToolResult(toolContent);
    if (toolResult.filePath && !filePath) {
      filePath = toolResult.filePath;
    }
    if (toolResult.message && !output) {
      output = toolResult.message;
    }
    
    console.log('SeeImageToolView: Using legacy format data:', {
      filePath,
      hasDescription: !!description,
      hasOutput: !!output
    });
  }

  console.log('SeeImageToolView: Final extracted data:', {
    filePath,
    hasDescription: !!description,
    hasOutput: !!output,
    actualIsSuccess
  });

  return {
    filePath,
    description,
    output,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
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
  
  if (project?.sandbox?.sandbox_url) {
    const sandboxUrl = project.sandbox.sandbox_url.replace(/\/$/, '');
    let normalizedPath = cleanPath;
    if (!normalizedPath.startsWith('/workspace')) {
      normalizedPath = `/workspace/${normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath}`;
    }
    
    const fullUrl = `${sandboxUrl}${normalizedPath}`;
    console.log('Constructed sandbox URL:', fullUrl);
    return fullUrl;
  }
  
  console.warn('No sandbox URL or ID available, using path as-is:', cleanPath);
  return cleanPath;
}