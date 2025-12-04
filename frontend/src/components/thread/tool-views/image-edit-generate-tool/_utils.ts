import { ToolCallData, ToolResultData } from '../types';

export interface ImageEditGenerateData {
  mode: 'generate' | 'edit' | null;
  prompt: string | null;
  inputImagePaths: string[];  // For edit mode - source images
  generatedImagePaths: string[];  // Output images
  status: string | null;
  error?: string | null;
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
  
  // Extract prompt - handle array (batch) or string (single)
  const promptArg = args.prompt;
  let prompt: string | null = null;
  if (Array.isArray(promptArg)) {
    // For batch, show first prompt (they're usually the same or similar)
    prompt = promptArg.length > 0 ? String(promptArg[0]) : null;
  } else if (promptArg) {
    prompt = String(promptArg);
  }
  
  // Extract input image paths for edit mode
  const inputImagePaths = parseImagePaths(args.image_path);
  
  // Extract generated image paths from output
  const generatedImagePaths = extractGeneratedImages(output);
  
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
    inputImagePaths,
    generatedImagePaths,
    status,
    error: toolResult?.error || null,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}
