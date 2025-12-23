import { ToolCall, ToolResult } from '../types';

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
  name: string;
}

export interface CanvasData {
  name: string;
  version: string;
  width: number;
  height: number;
  background: string;
  description?: string;
  elements: CanvasElement[];
  created_at: string;
  updated_at: string;
}

export interface ExtractedCanvasData {
  canvasName: string | null;
  canvasPath: string | null;
  canvasData: CanvasData | null;
  width: number | null;
  height: number | null;
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
    width: null,
    height: null,
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
  let width = args.width || null;
  let height = args.height || null;
  let background = args.background || '#ffffff';

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
    width = width || parsedResult.width;
    height = height || parsedResult.height;
    background = background || parsedResult.background || '#ffffff';
  }

  const actualIsSuccess = toolResult?.success ?? isSuccess;
  const status = parsedResult?.status;
  const error = parsedResult?.error;
  const sandbox_id = parsedResult?.sandbox_id || toolCall.metadata?.sandbox_id;

  return {
    canvasName,
    canvasPath,
    canvasData: parsedResult?.canvas_data || null,
    width,
    height,
    background,
    totalElements: parsedResult?.total_elements || 0,
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

