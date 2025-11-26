import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface DesignerData {
  mode?: string;
  prompt?: string;
  imagePath?: string;
  generatedImagePath?: string;
  designUrl?: string;
  width?: number;
  height?: number;
  designStyle?: string;
  platformPreset?: string;
  error?: string;
  success: boolean;
  sandboxId?: string;
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

export function extractDesignerData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }): DesignerData {
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })()
      : {};
  
  let generatedImagePath: string | undefined;
  let designUrl: string | undefined;
  let error: string | undefined;
  let sandboxId: string | undefined;
  let success = toolResult?.success ?? true;

  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;    if (output && typeof output === 'object') {
      generatedImagePath = output.design_path || output.generated_image_path || output.image_path || output.file_path;
      designUrl = output.design_url;
      sandboxId = output.sandbox_id;
      error = output.error;
      if (output.success !== undefined) {
        success = output.success;
      }
    } else if (typeof output === 'string') {
      const pathMatch = output.match(/Design saved at:\s*([^\s]+)/i);
      if (pathMatch) {
        generatedImagePath = pathMatch[1];
      } else {
        const anyPathMatch = output.match(/(\/workspace\/designs\/[^\s]+\.png)/i);
        if (anyPathMatch) {
          generatedImagePath = anyPathMatch[1];
        } else {
          const filenameMatch = output.match(/design_\d+x\d+_[\w]+\.png/i);
          if (filenameMatch) {
            generatedImagePath = `/workspace/designs/${filenameMatch[0]}`;
          }
        }
      }
      
      if (output.includes('error') || output.includes('Error') || output.includes('Failed')) {
        error = output;
        success = false;
      }
    }
  }
  
  console.log('🎨 [Designer Utils] Extracted data:', {
    generatedImagePath,
    designUrl,
    sandboxId,
    args,
    output: toolResult?.output,
    success
  });
  
  return {
    mode: args?.mode,
    prompt: args?.prompt,
    imagePath: args?.image_path,
    generatedImagePath,
    designUrl,
    width: args?.width,
    height: args?.height,
    designStyle: args?.design_style,
    platformPreset: args?.platform_preset,
    error,
    success,
    sandboxId
  };
}

