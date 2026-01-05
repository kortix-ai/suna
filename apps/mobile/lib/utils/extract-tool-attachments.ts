/**
 * Extract file attachments from tool results
 * 
 * This utility extracts generated/created files from various tool results
 * (image generation, presentation creation, file writes, etc.) to display
 * them inline in the assistant response.
 */

import type { UnifiedMessage } from '@/api/types';
import { parseToolMessage } from './tool-parser';

export interface ExtractedAttachment {
  filePath: string;
  toolName: string;
  toolCallId?: string;
}

/**
 * Extract file paths from a tool result output
 */
function extractFilePathsFromOutput(output: any, toolName: string): string[] {
  const filePaths: string[] = [];
  
  if (!output) return filePaths;
  
  // Handle string output (e.g., "Image saved as: /workspace/image.png")
  if (typeof output === 'string') {
    // Match common patterns for file paths
    const patterns = [
      /(?:saved as|created|generated|path):\s*(\/workspace\/[^\s\n]+)/gi,
      /\/workspace\/[a-zA-Z0-9_\-\/\.]+\.(png|jpg|jpeg|gif|webp|mp4|pdf|html|pptx|docx|xlsx)/gi,
    ];
    
    patterns.forEach(pattern => {
      const matches = output.matchAll(pattern);
      for (const match of matches) {
        const path = match[1] || match[0];
        if (path && !filePaths.includes(path)) {
          // Ensure path starts with /workspace/
          const normalizedPath = path.startsWith('/workspace/') ? path : `/workspace/${path}`;
          filePaths.push(normalizedPath);
        }
      }
    });
    
    // Also try to find bare filenames and prepend /workspace/
    if (filePaths.length === 0) {
      const bareFilenamePattern = /([a-zA-Z0-9_\-]+\.(png|jpg|jpeg|gif|webp|mp4|pdf|html))/gi;
      const matches = output.matchAll(bareFilenamePattern);
      for (const match of matches) {
        const filename = match[1];
        if (filename && !filename.includes('/')) {
          filePaths.push(`/workspace/${filename}`);
        }
      }
    }
  }
  
  // Handle object output with specific fields
  if (typeof output === 'object') {
    // Image generation tool
    if ('generated_image_paths' in output && Array.isArray(output.generated_image_paths)) {
      output.generated_image_paths.forEach((path: string) => {
        const normalizedPath = path.startsWith('/workspace/') ? path : `/workspace/${path}`;
        filePaths.push(normalizedPath);
      });
    }
    
    // Video generation tool
    if ('generated_video_paths' in output && Array.isArray(output.generated_video_paths)) {
      output.generated_video_paths.forEach((path: string) => {
        const normalizedPath = path.startsWith('/workspace/') ? path : `/workspace/${path}`;
        filePaths.push(normalizedPath);
      });
    }
    
    // Presentation tool
    if ('presentation_path' in output && typeof output.presentation_path === 'string') {
      const path = output.presentation_path;
      const normalizedPath = path.startsWith('/workspace/') ? path : `/workspace/${path}`;
      filePaths.push(normalizedPath);
    }
    
    // Generic file path fields
    ['file_path', 'filepath', 'path', 'output_path'].forEach(field => {
      if (field in output && typeof output[field] === 'string') {
        const path = output[field];
        const normalizedPath = path.startsWith('/workspace/') ? path : `/workspace/${path}`;
        filePaths.push(normalizedPath);
      }
    });
  }
  
  return filePaths;
}

/**
 * Extract attachments from a list of tool messages
 * Returns file paths that should be displayed inline
 */
export function extractToolAttachments(toolMessages: UnifiedMessage[]): ExtractedAttachment[] {
  const attachments: ExtractedAttachment[] = [];
  
  // Tools that should show inline previews
  const inlinePreviewTools = [
    'image_edit_or_generate',
    'image-edit-or-generate',
    'create_presentation',
    'create-presentation',
    'write_file', // Only for .html, .png, .jpg, etc.
    'write-file',
  ];
  
  toolMessages.forEach(toolMsg => {
    const parsed = parseToolMessage(toolMsg);
    if (!parsed) return;
    
    const toolName = parsed.functionName || '';
    
    // Check if this tool should have inline previews
    if (!inlinePreviewTools.some(t => toolName.includes(t.replace(/-/g, '_')))) {
      return;
    }
    
    // Extract file paths from the result output
    const output = parsed.result?.output;
    const filePaths = extractFilePathsFromOutput(output, toolName);
    
    // Filter to only previewable file types
    const previewableExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.html', '.pdf'];
    const previewableFiles = filePaths.filter(path => 
      previewableExtensions.some(ext => path.toLowerCase().endsWith(ext))
    );
    
    previewableFiles.forEach(filePath => {
      attachments.push({
        filePath,
        toolName: parsed.toolName,
        toolCallId: parsed.toolCallId,
      });
    });
  });
  
  return attachments;
}

