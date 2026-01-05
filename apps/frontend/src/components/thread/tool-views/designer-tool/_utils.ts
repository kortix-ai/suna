import { ToolCallData, ToolResultData } from '../types';

export interface DesignerData {
  mode: string | null;
  prompt: string | null;
  designStyle: string | null;
  platformPreset: string | null;
  width: number | null;
  height: number | null;
  quality: string | null;
  imagePath: string | null;
  generatedImagePath?: string;
  designUrl?: string;
  status?: string;
  error?: string;
  sandbox_id?: string;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
}

export function extractDesignerData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): DesignerData {
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments);
          } catch {
            return {};
          }
        })()
      : {};

  const mode = args.mode || null;
  const prompt = args.prompt || null;
  const designStyle = args.design_style || null;
  const platformPreset = args.platform_preset || null;
  const width = args.width || null;
  const height = args.height || null;
  const quality = args.quality || null;
  const imagePath = args.image_path || null;

  let generatedImagePath: string | undefined;
  let designUrl: string | undefined;
  let status: string | undefined;
  let error: string | undefined;
  let actualIsSuccess = isSuccess;
  const actualToolTimestamp = toolTimestamp;
  const actualAssistantTimestamp = assistantTimestamp;
  let sandbox_id: string | undefined;

  if (toolResult?.output) {
    let output: any = toolResult.output;
    
    if (typeof output === 'string') {
      try {
        output = JSON.parse(output);
      } catch (e) {
        // If parsing fails, treat as a simple status message
        status = output;
        if (output.includes('error') || output.includes('Error') || output.includes('Failed')) {
          error = output;
          actualIsSuccess = false;
        }
        
        // Try to extract path from string
        const pathMatch = output.match(/Design saved at:\s*([^\s]+)/i);
        if (pathMatch) {
          generatedImagePath = pathMatch[1];
        } else {
          const anyPathMatch = output.match(/(\/workspace\/designs\/[^\s]+\.png)/i);
          if (anyPathMatch) {
            generatedImagePath = anyPathMatch[1];
          }
        }
      }
    }

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
    }
  }

  // Update success from toolResult if available
  if (toolResult?.success !== undefined) {
    actualIsSuccess = toolResult.success;
  }

  return {
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
    sandbox_id,
    actualIsSuccess: toolResult?.success ?? actualIsSuccess,
    actualToolTimestamp: actualToolTimestamp,
    actualAssistantTimestamp: actualAssistantTimestamp
  };
}
