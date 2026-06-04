import type { ToolCallData, ToolResultData } from '@/lib/utils/tool-data-extractor';

export interface ImageEditData {
  prompt?: string;
  mode?: string;
  imagePath?: string;
  generatedImagePath?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
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

export function extractImageEditData({ toolCall, toolResult }: { toolCall: ToolCallData; toolResult?: ToolResultData }, sandboxId?: string): ImageEditData {
  const args = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
    ? toolCall.arguments
    : typeof toolCall.arguments === 'string'
      ? (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })()
      : {};
  
  let generatedImagePath: string | undefined;
  let imageUrl: string | undefined;
  let error: string | undefined;
  let extractedSandboxId: string | undefined;
  
  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string' 
      ? parseContent(toolResult.output) 
      : toolResult.output;
    
    if (output && typeof output === 'object') {
      // Check for direct image URL first (from image_edit_or_generate)
      imageUrl = output.image_url;
      
      // Then check for file paths (from sandbox)
      generatedImagePath = output.generated_image_path || output.image_path || output.file_path || output.path;
      error = output.error;
      extractedSandboxId = output.sandbox_id;
      
      // If we have a path but it doesn't start with /, prefix with /workspace/
      if (generatedImagePath && !generatedImagePath.startsWith('/') && !imageUrl) {
        generatedImagePath = `/workspace/${generatedImagePath}`;
      }
    } else if (typeof output === 'string') {
      // Match patterns like "Image saved as: Geometric Glass Facade.png" (with spaces)
      // or legacy format like "Image saved as: generated_image_966956f9.png"
      const imagePathMatch = output.match(/Image saved as:\s*(?:\/workspace\/)?(.+\.(png|jpg|jpeg|webp|gif))/i) ||
                            output.match(/saved as:\s*(?:\/workspace\/)?(.+\.(png|jpg|jpeg|webp|gif))/i) ||
                            output.match(/(\/workspace\/.+\.(png|jpg|jpeg|webp))/i) ||
                            output.match(/(generated_image_[\w]+\.(png|jpg|jpeg|webp))/i);
      if (imagePathMatch) {
        const path = (imagePathMatch[1] || imagePathMatch[0]).trim();
        generatedImagePath = path.startsWith('/') ? path : `/workspace/${path}`;
      }
      
      if (output.includes('error') || output.includes('Error') || output.includes('Failed')) {
        error = output;
      }
    }
  }
  
  return {
    prompt: args?.prompt,
    mode: args?.mode,
    imagePath: args?.image_path,
    generatedImagePath,
    imageUrl,
    width: args?.width,
    height: args?.height,
    error,
    success: toolResult?.success ?? true,
    sandboxId: extractedSandboxId || sandboxId
  };
}

