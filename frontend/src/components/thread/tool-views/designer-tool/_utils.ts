import { extractToolData, normalizeContentToString } from '../utils';

interface DesignerData {
  mode?: string;
  prompt?: string;
  designStyle?: string;
  platformPreset?: string;
  width?: number;
  height?: number;
  quality?: string;
  imagePath?: string;
  generatedImagePath?: string;
  designUrl?: string;
  status?: string;
  error?: string;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
  sandbox_id?: string;
}

export function extractDesignerData(
  assistantContent: string | object | undefined | null,
  toolContent: string | object | undefined | null,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): DesignerData {
  const assistantData = extractToolData(assistantContent);
  const toolData = extractToolData(toolContent);

  const mode = assistantData.arguments?.mode;
  const prompt = assistantData.arguments?.prompt;
  const designStyle = assistantData.arguments?.design_style;
  const platformPreset = assistantData.arguments?.platform_preset;
  const width = assistantData.arguments?.width;
  const height = assistantData.arguments?.height;
  const quality = assistantData.arguments?.quality;
  const imagePath = assistantData.arguments?.image_path;

  let generatedImagePath: string | undefined;
  let designUrl: string | undefined;
  let status: string | undefined;
  let error: string | undefined;
  let actualIsSuccess = isSuccess;
  const actualToolTimestamp = toolTimestamp;
  const actualAssistantTimestamp = assistantTimestamp;
  let sandbox_id: string | undefined;

  if (toolContent && typeof toolContent === 'object') {
    const tc = toolContent as any;
    
    if (tc.sandbox_id) {
      sandbox_id = tc.sandbox_id;
    }
    
    if (tc.tool_execution?.result?.output) {
      const output = tc.tool_execution.result.output;
      actualIsSuccess = tc.tool_execution.result.success !== false;
      
      if (typeof output === 'object' && output !== null) {
        if (output.design_path) {
          generatedImagePath = output.design_path;
        }
        if (output.design_url) {
          designUrl = output.design_url;
        }
        if (output.message) {
          status = output.message;
        }
        if (output.success !== undefined) {
          actualIsSuccess = output.success;
        }
        if (output.sandbox_id) {
          sandbox_id = output.sandbox_id;
        }
      } else if (typeof output === 'string') {
        status = output;
        
        const pathMatch = output.match(/Design saved at:\s*([^\s]+)/i);
        if (pathMatch) {
          generatedImagePath = pathMatch[1];
        } else {
          const anyPathMatch = output.match(/(\/workspace\/designs\/[^\s]+\.png)/i);
          if (anyPathMatch) {
            generatedImagePath = anyPathMatch[1];
          }
        }
        
        if (output.includes('error') || output.includes('Error') || output.includes('Failed')) {
          error = output;
          actualIsSuccess = false;
        }
      }
    }
    
    if (tc.metadata?.frontend_content?.tool_execution?.result?.output) {
      const output = tc.metadata.frontend_content.tool_execution.result.output;
      if (typeof output === 'object' && output !== null) {
        if (!generatedImagePath && output.design_path) {
          generatedImagePath = output.design_path;
        }
        if (!designUrl && output.design_url) {
          designUrl = output.design_url;
        }
      } else if (typeof output === 'string' && !generatedImagePath) {
        const pathMatch = output.match(/(\/workspace\/designs\/[^\s]+\.png)/i);
        if (pathMatch) {
          generatedImagePath = pathMatch[1];
        }
      }
    }
  }

  if (!generatedImagePath && toolContent) {
    const toolResult = toolData.toolResult;
    
    if (toolResult?.toolOutput && typeof toolResult.toolOutput === 'string') {
      const result = toolResult.toolOutput;
      
      const fullPathMatch = result.match(/(\/workspace\/designs\/[^\s]+\.png)/i);
      if (fullPathMatch) {
        generatedImagePath = fullPathMatch[1];
      } else {
        const filenameMatch = result.match(/(?:Design saved (?:as|at):\s*)?(design_\d+x\d+_[\w]+\.png)/i);
        if (filenameMatch) {
          generatedImagePath = `/workspace/designs/${filenameMatch[1]}`;
        }
      }

      status = result;

      if (result.includes('error') || result.includes('Error') || result.includes('Failed')) {
        error = result;
        actualIsSuccess = false;
      } else if (result.includes('Successfully')) {
        actualIsSuccess = true;
      }
    }
    
    if (toolResult?.isSuccess !== undefined) {
      actualIsSuccess = toolResult.isSuccess;
    }
  }

  const contentStr = normalizeContentToString(toolContent);
  if (contentStr && !generatedImagePath) {
    const fullPathMatch = contentStr.match(/(\/workspace\/designs\/[^\s]+\.png)/i);
    if (fullPathMatch) {
      generatedImagePath = fullPathMatch[1];
    } else {
      const filenameMatch = contentStr.match(/design_\d+x\d+_[\w]+\.png/i);
      if (filenameMatch) {
        generatedImagePath = `/workspace/designs/${filenameMatch[0]}`;
      }
    }
  }

  const result = {
    mode,
    prompt,
    designStyle,
    platformPreset,
    width,
    height,
    quality,
    imagePath,
    generatedImagePath,
    designUrl,
    status,
    error,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp,
    sandbox_id,
  };
  
  console.log('Designer Tool Data Extraction:', {
    toolContent,
    extractedImagePath: generatedImagePath,
    status,
    success: actualIsSuccess,
    fullExtractedData: result
  });
  
  return result;
} 