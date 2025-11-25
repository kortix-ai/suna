import { ToolCallData, ToolResultData } from '../types';

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

export function extractImageEditGenerateData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ImageEditGenerateData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const args = toolCall.arguments || {};
  const output = toolResult?.output;
  
  // Extract generated image path from output
  let generatedImagePath: string | null = null;
  if (output) {
    if (typeof output === 'string') {
      // Look for patterns like "Image saved as: generated_image_xxx.png" or "Saved to: path/to/image.png"
      const patterns = [
        /Image saved as:\s*([^\s\n]+\.(png|jpg|jpeg|webp|gif))/i,
        /Saved to:\s*([^\s\n]+\.(png|jpg|jpeg|webp|gif))/i,
        /Generated image:\s*([^\s\n]+\.(png|jpg|jpeg|webp|gif))/i,
        /File:\s*([^\s\n]+\.(png|jpg|jpeg|webp|gif))/i,
        // Direct file paths (not URLs)
        /([\/\w\-\.]+\.(png|jpg|jpeg|webp|gif))/i
      ];
      
      for (const pattern of patterns) {
        const match = output.match(pattern);
        if (match && match[1]) {
          const candidatePath = match[1].trim();
          // Exclude URLs and common false positives
          if (!candidatePath.includes('http') && 
              !candidatePath.includes('data:') &&
              !candidatePath.startsWith('www.') &&
              candidatePath.length > 3) {
            generatedImagePath = candidatePath;
            break;
          }
        }
      }
    } else if (typeof output === 'object' && output !== null) {
      // Check for image_path or generated_image_path in object
      const obj = output as any;
      generatedImagePath = obj.image_path || 
                          obj.generated_image_path || 
                          obj.file_path || 
                          obj.path ||
                          obj.output_path ||
                          obj.result_path ||
                          null;
      
      // If still null, check nested objects
      if (!generatedImagePath && obj.result) {
        generatedImagePath = obj.result.image_path || obj.result.file_path || null;
      }
    }
  }

  const extractedData: ImageEditGenerateData = {
    mode: args.mode || null,
    prompt: args.prompt || null,
    imagePath: args.image_path || null,
    generatedImagePath,
    status: typeof output === 'string' ? output : null,
    success: toolResult?.success,
    timestamp: undefined,
    error: toolResult?.error || null
  };

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    ...extractedData,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
