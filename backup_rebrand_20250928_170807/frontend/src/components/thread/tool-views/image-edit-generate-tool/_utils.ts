import { extractToolData, normalizeContentToString } from '../utils';

export interface ImageEditGenerateData {
  mode: 'generate' | 'edit' | null;
  prompt: string | null;
  imagePath: string | null;
  generatedImagePath: string | null;
  status: string | null;
  success?: boolean;
  timestamp?: string;
  error?: string | null;
  
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

const extractFromNewFormat = (content: any): ImageEditGenerateData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { 
      mode: null, 
      prompt: null, 
      imagePath: null, 
      generatedImagePath: null, 
      status: null, 
      success: undefined, 
      timestamp: undefined,
      error: null
    };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    const args = toolExecution.arguments || {};
    const result = toolExecution.result || {};
    
    // Extract generated image path from the output
    let generatedImagePath: string | null = null;
    if (result.output && typeof result.output === 'string') {
      // Look for patterns like "Image saved as: generated_image_xxx.png"
      const imagePathMatch = result.output.match(/Image saved as:\s*([^\s.]+\.(png|jpg|jpeg|webp|gif))/i);
      if (imagePathMatch) {
        generatedImagePath = imagePathMatch[1];
      }
    }

    const extractedData: ImageEditGenerateData = {
      mode: args.mode || null,
      prompt: args.prompt || null,
      imagePath: args.image_path || null,
      generatedImagePath,
      status: result.output || null,
      success: result.success,
      timestamp: toolExecution.execution_details?.timestamp,
      error: result.error || null
    };
    
    return extractedData;
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { 
    mode: null, 
    prompt: null, 
    imagePath: null, 
    generatedImagePath: null, 
    status: null, 
    success: undefined, 
    timestamp: undefined,
    error: null
  };
};

const extractFromLegacyFormat = (content: any): ImageEditGenerateData => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult && toolData.arguments) {
    // Extract generated image path from the result
    let generatedImagePath: string | null = null;
    if (toolData.toolResult && typeof toolData.toolResult === 'string') {
      const imagePathMatch = (toolData.toolResult as string).match(/Image saved as:\s*([^\s.]+\.(png|jpg|jpeg|webp|gif))/i);
      if (imagePathMatch) {
        generatedImagePath = imagePathMatch[1];
      }
    }
    
    return {
      mode: toolData.arguments.mode || null,
      prompt: toolData.arguments.prompt || null,
      imagePath: toolData.arguments.image_path || null,
      generatedImagePath,
      status: toolData.toolResult?.toolOutput || null,
      success: toolData.toolResult?.isSuccess,
      timestamp: undefined,
      error: null
    };
  }

  const contentStr = normalizeContentToString(content);
  if (!contentStr) {
    return { 
      mode: null, 
      prompt: null, 
      imagePath: null, 
      generatedImagePath: null, 
      status: null,
      success: undefined,
      timestamp: undefined,
      error: null
    };
  }

  // Try to extract data from XML-like format
  let mode: 'generate' | 'edit' | null = null;
  const modeMatch = contentStr.match(/<parameter name="mode">([^<]*)<\/parameter>/i);
  if (modeMatch) {
    mode = modeMatch[1].trim() as 'generate' | 'edit';
  }

  let prompt: string | null = null;
  const promptMatch = contentStr.match(/<parameter name="prompt">([^<]*)<\/parameter>/i);
  if (promptMatch) {
    prompt = promptMatch[1].trim();
  }

  let imagePath: string | null = null;
  const imagePathMatch = contentStr.match(/<parameter name="image_path">([^<]*)<\/parameter>/i);
  if (imagePathMatch) {
    imagePath = imagePathMatch[1].trim();
  }

  // Try to extract generated image path from output
  let generatedImagePath: string | null = null;
  const generatedImageMatch = contentStr.match(/Image saved as:\s*([^\s.]+\.(png|jpg|jpeg|webp|gif))/i);
  if (generatedImageMatch) {
    generatedImagePath = generatedImageMatch[1];
  }
  
  return {
    mode,
    prompt,
    imagePath,
    generatedImagePath,
    status: null,
    success: undefined,
    timestamp: undefined,
    error: null
  };
};

export function extractImageEditGenerateData(
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ImageEditGenerateData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  // Prefer data from toolContent if it has meaningful data
  let finalData = { ...assistantNewFormat };
  
  if (toolNewFormat.mode || toolNewFormat.prompt || toolNewFormat.generatedImagePath) {
    finalData = { ...toolNewFormat };
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else if (assistantNewFormat.mode || assistantNewFormat.prompt || assistantNewFormat.generatedImagePath) {
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else {
    // Fall back to legacy format
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    finalData = {
      mode: toolLegacy.mode || assistantLegacy.mode,
      prompt: toolLegacy.prompt || assistantLegacy.prompt,
      imagePath: toolLegacy.imagePath || assistantLegacy.imagePath,
      generatedImagePath: toolLegacy.generatedImagePath || assistantLegacy.generatedImagePath,
      status: toolLegacy.status || assistantLegacy.status,
      success: toolLegacy.success || assistantLegacy.success,
      timestamp: toolLegacy.timestamp || assistantLegacy.timestamp,
      error: toolLegacy.error || assistantLegacy.error
    };
  }
  
  return {
    ...finalData,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}
