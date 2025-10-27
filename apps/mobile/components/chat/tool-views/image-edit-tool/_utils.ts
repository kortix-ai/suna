import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface ImageEditData {
  prompt?: string;
  mode?: string;
  imagePath?: string;
  generatedImagePath?: string;
  width?: number;
  height?: number;
  error?: string;
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

export function extractImageEditData(toolData: ParsedToolData, sandboxId?: string): ImageEditData {
  const { arguments: args, result } = toolData;
  
  let generatedImagePath: string | undefined;
  let error: string | undefined;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    if (output && typeof output === 'object') {
      generatedImagePath = output.generated_image_path || output.image_path || output.file_path || output.path;
      error = output.error;
    } else if (typeof output === 'string') {
      const imagePathMatch = output.match(/Image saved as:\s*([^\s.]+\.(png|jpg|jpeg|webp|gif))/i) ||
                            output.match(/(\/workspace\/[^\s]+\.(png|jpg|jpeg|webp))/i) ||
                            output.match(/generated_image_[\w]+\.(png|jpg|jpeg|webp)/i);
      if (imagePathMatch) {
        const path = imagePathMatch[1] || imagePathMatch[0];
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
    width: args?.width,
    height: args?.height,
    error,
    success: result.success ?? true
  };
}

