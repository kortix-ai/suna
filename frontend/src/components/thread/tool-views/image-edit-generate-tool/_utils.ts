import { ToolCallData, ToolResultData } from '../types';

export interface BatchImageResult {
  prompt: string;
  success: boolean;
  imageFilename: string | null;
  inputImagePath: string | null;
  error: string | null;
}

export interface ImageEditGenerateData {
  mode: 'generate' | 'edit' | null;
  prompt: string | null;
  prompts: string[];  // All prompts for batch
  inputImagePaths: string[];  // For edit mode - source images
  generatedImagePaths: string[];  // Output images
  status: string | null;
  error?: string | null;
  isBatch: boolean;
  batchResults: BatchImageResult[];
}

/**
 * Parse image path which could be a string, JSON string array, or array
 */
function parseImagePaths(imagePath: unknown): string[] {
  if (!imagePath) return [];
  
  // Already an array
  if (Array.isArray(imagePath)) {
    return imagePath.filter(p => typeof p === 'string' && p.trim());
  }
  
  // String that might be JSON array
  if (typeof imagePath === 'string') {
    const trimmed = imagePath.trim();
    
    // Try to parse as JSON array
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter(p => typeof p === 'string' && p.trim());
        }
      } catch {
        // Not valid JSON, treat as single path
      }
    }
    
    // Single path
    if (trimmed) {
      return [trimmed];
    }
  }
  
  return [];
}

/**
 * Extract generated image filenames from tool output
 */
function extractGeneratedImages(output: unknown): string[] {
  const images: string[] = [];
  
  if (!output) return images;
  
  if (typeof output === 'string') {
    // Pattern 1: "Image saved as: filename.png"
    const singleMatch = output.match(/Image saved as:\s*([^\s\n.]+\.(?:png|jpg|jpeg|webp|gif))/i);
    if (singleMatch?.[1]) {
      images.push(singleMatch[1].trim());
    }
    
    // Pattern 2: "- filename.png" (batch mode list)
    const batchMatches = output.matchAll(/^- ([^\n]+\.(?:png|jpg|jpeg|webp|gif))/gim);
    for (const match of batchMatches) {
      if (match[1] && !images.includes(match[1].trim())) {
        images.push(match[1].trim());
      }
    }
    
    // Pattern 3: Direct generated_image_xxx.png pattern
    if (images.length === 0) {
      const directMatches = output.matchAll(/(generated_image_[a-z0-9]+\.(?:png|jpg|jpeg|webp|gif))/gi);
      for (const match of directMatches) {
        if (match[1] && !images.includes(match[1].trim())) {
          images.push(match[1].trim());
        }
      }
    }
  } else if (typeof output === 'object' && output !== null) {
    const obj = output as Record<string, unknown>;
    
    // Check for batch results array
    if (Array.isArray(obj.results)) {
      for (const result of obj.results) {
        if (typeof result === 'object' && result !== null) {
          const r = result as Record<string, unknown>;
          if (typeof r.image_filename === 'string' && r.image_filename) {
            images.push(r.image_filename);
          }
        }
      }
    }
    
    // Check for single image path fields
    const pathFields = ['image_path', 'file_path', 'output_path', 'generated_image_path'];
    for (const field of pathFields) {
      if (typeof obj[field] === 'string' && obj[field] && !images.includes(obj[field] as string)) {
        images.push(obj[field] as string);
      }
    }
  }
  
  return images;
}

/**
 * Extract error message from output string
 */
function extractErrorMessage(output: string): string | null {
  // Pattern: "Failed (N): error message"
  const failedMatch = output.match(/Failed \(\d+\):\s*(.+?)(?:\n|$)/i);
  if (failedMatch?.[1]) {
    return failedMatch[1].trim();
  }
  
  // Pattern: "Failed: error message" (single mode)
  const singleFailedMatch = output.match(/Failed:\s*(.+?)(?:\n|$)/i);
  if (singleFailedMatch?.[1]) {
    return singleFailedMatch[1].trim();
  }
  
  return null;
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
  
  // Extract prompts - handle array (batch) or string (single)
  const promptArg = args.prompt;
  let prompts: string[] = [];
  let prompt: string | null = null;
  
  if (Array.isArray(promptArg)) {
    prompts = promptArg.filter(p => typeof p === 'string' && p.trim()).map(p => String(p));
    prompt = prompts.length > 0 ? prompts[0] : null;
  } else if (promptArg) {
    prompt = String(promptArg);
    prompts = [prompt];
  }
  
  const isBatch = prompts.length > 1;
  
  // Extract input image paths for edit mode
  const inputImagePaths = parseImagePaths(args.image_path);
  
  // Extract generated image paths from output
  const generatedImagePaths = extractGeneratedImages(output);
  
  // Extract error message
  let errorMessage: string | null = null;
  if (typeof output === 'string') {
    errorMessage = extractErrorMessage(output);
  }
  
  // Build batch results - map prompts to images/errors
  const batchResults: BatchImageResult[] = [];
  
  if (isBatch) {
    let imageIndex = 0;
    const totalFailed = prompts.length - generatedImagePaths.length;
    
    for (let i = 0; i < prompts.length; i++) {
      const hasImage = imageIndex < generatedImagePaths.length;
      // Determine if this prompt succeeded or failed
      // Images are returned in order for successful ones
      // We assume first N prompts map to N images, rest are failures
      const isSuccessful = i < generatedImagePaths.length;
      
      batchResults.push({
        prompt: prompts[i],
        success: isSuccessful,
        imageFilename: isSuccessful ? generatedImagePaths[i] : null,
        inputImagePath: i < inputImagePaths.length ? inputImagePaths[i] : (inputImagePaths[0] || null),
        error: isSuccessful ? null : (errorMessage || 'Processing failed'),
      });
    }
  } else if (prompts.length === 1) {
    // Single prompt mode
    const hasImage = generatedImagePaths.length > 0;
    batchResults.push({
      prompt: prompts[0],
      success: hasImage,
      imageFilename: hasImage ? generatedImagePaths[0] : null,
      inputImagePath: inputImagePaths[0] || null,
      error: hasImage ? null : errorMessage,
    });
  }
  
  // Determine success
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;
  
  // Extract status message
  let status: string | null = null;
  if (typeof output === 'string') {
    status = output;
  }

  return {
    mode: args.mode || null,
    prompt,
    prompts,
    inputImagePaths,
    generatedImagePaths,
    status,
    error: toolResult?.error || errorMessage || null,
    isBatch,
    batchResults,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
