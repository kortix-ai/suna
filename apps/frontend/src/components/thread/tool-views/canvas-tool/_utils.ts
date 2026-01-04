import { ToolCallData, ToolResultData } from '../types';

// Legacy type aliases for compatibility
type ToolCall = ToolCallData | { name?: string; arguments?: Record<string, any>; metadata?: any };
type ToolResult = ToolResultData | { output?: any; success?: boolean } | null;

export interface CanvasElement {
  id: string;
  type: 'image';
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  locked: boolean;
  visible: boolean;
  name: string;
}

export interface CanvasData {
  name: string;
  version: string;
  background: string;
  description?: string;
  elements: CanvasElement[];
  created_at: string;
  updated_at: string;
  // Optional - canvas is infinite, no fixed dimensions
  width?: number;
  height?: number;
}

export interface ExtractedCanvasData {
  canvasName: string | null;
  canvasPath: string | null;
  canvasData: CanvasData | null;
  background: string | null;
  totalElements: number;
  status: string | undefined;
  error: string | undefined;
  actualIsSuccess: boolean;
  actualToolTimestamp: string | undefined;
  actualAssistantTimestamp: string | undefined;
  sandbox_id: string | undefined;
}

/**
 * Extract canvas data from tool call and result
 */
export function extractCanvasData(
  toolCall: ToolCall,
  toolResult: ToolResult | null,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): ExtractedCanvasData {
  const defaultData: ExtractedCanvasData = {
    canvasName: null,
    canvasPath: null,
    canvasData: null,
    background: null,
    totalElements: 0,
    status: undefined,
    error: undefined,
    actualIsSuccess: false,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
    sandbox_id: undefined,
  };

  if (!toolCall) {
    return defaultData;
  }

  // Extract from tool call arguments
  const args = toolCall.arguments || {};
  
  let canvasName = args.name || args.canvas_name || null;
  let canvasPath = args.canvas_path || null;
  let background = args.background || '#1a1a1a';

  // Parse tool result if available
  let parsedResult: any = null;
  if (toolResult?.output) {
    try {
      if (typeof toolResult.output === 'string') {
        parsedResult = JSON.parse(toolResult.output);
      } else {
        parsedResult = toolResult.output;
      }
    } catch (e) {
      console.warn('Failed to parse tool result:', e);
    }
  }

  // Extract additional data from result
  if (parsedResult) {
    canvasName = canvasName || parsedResult.canvas_name || parsedResult.name;
    canvasPath = canvasPath || parsedResult.canvas_path;
    background = parsedResult.background || background;
  }

  const actualIsSuccess = toolResult?.success ?? isSuccess;
  const status = parsedResult?.status;
  const error = parsedResult?.error;
  const sandbox_id = parsedResult?.sandbox_id || (toolCall as any).metadata?.sandbox_id;

  return {
    canvasName,
    canvasPath,
    canvasData: parsedResult?.canvas_data || null,
    background,
    totalElements: parsedResult?.total_elements || parsedResult?.element_count || 0,
    status,
    error,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
    sandbox_id,
  };
}

/**
 * Check if a file path is a canvas file
 */
export function isCanvasFile(filePath: string): boolean {
  if (!filePath) return false;
  return /\.kanvax$/i.test(filePath) || /canvases\/[^\/]+\.kanvax$/i.test(filePath);
}

/**
 * Parse canvas file path to extract canvas name
 */
export function parseCanvasFilePath(filePath: string | null): {
  isValid: boolean;
  canvasName: string | null;
} {
  if (!filePath) {
    return { isValid: false, canvasName: null };
  }
  
  // Match patterns like:
  // - canvases/[name].kanvax
  // - /workspace/canvases/[name].kanvax
  // - ./canvases/[name].kanvax
  const match = filePath.match(/canvases\/([^\/]+)\.kanvax$/i);
  if (match) {
    return {
      isValid: true,
      canvasName: match[1]
    };
  }
  
  return { isValid: false, canvasName: null };
}

