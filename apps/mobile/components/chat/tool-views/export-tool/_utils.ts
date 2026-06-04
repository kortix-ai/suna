import type { ToolViewProps } from '../types';
import { log } from '@/lib/logger';

export interface ExportData {
  presentationName?: string;
  filePath?: string;
  downloadUrl?: string;
  totalSlides?: number;
  storedLocally?: boolean;
  message?: string;
  note?: string;
  success: boolean;
  format: 'pdf' | 'pptx';
}

/**
 * Extract export data from tool call and result
 */
export function extractExportData({
  toolCall,
  toolResult,
}: Pick<ToolViewProps, 'toolCall' | 'toolResult'>): ExportData {
  const functionName = toolCall?.function_name || '';
  const format: 'pdf' | 'pptx' = functionName.includes('pdf') ? 'pdf' : 'pptx';
  
  let presentationName: string | undefined;
  let filePath: string | undefined;
  let downloadUrl: string | undefined;
  let totalSlides: number | undefined;
  let storedLocally: boolean | undefined;
  let message: string | undefined;
  let note: string | undefined;
  let success = toolResult?.success !== false;

  // Extract from tool result
  if (toolResult?.output) {
    try {
      const output = typeof toolResult.output === 'string' 
        ? JSON.parse(toolResult.output) 
        : toolResult.output;

      presentationName = output.presentation_name;
      filePath = output[`${format}_file`] || output.pdf_file || output.pptx_file;
      downloadUrl = output.download_url;
      totalSlides = output.total_slides;
      storedLocally = output.stored_locally;
      message = output.message;
      note = output.note;
    } catch (e) {
      log.error('[extractExportData] Failed to parse output:', e);
    }
  }

  // Fallback to arguments
  if (!presentationName && toolCall?.arguments) {
    const args = typeof toolCall.arguments === 'object' 
      ? toolCall.arguments 
      : (() => {
          try {
            return JSON.parse(toolCall.arguments as string);
          } catch {
            return {};
          }
        })();
    
    presentationName = args.presentation_name || args.presentationName;
  }

  return {
    presentationName,
    filePath,
    downloadUrl,
    totalSlides,
    storedLocally,
    message,
    note,
    success,
    format,
  };
}
