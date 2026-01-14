/**
 * @agentpress/kanvax - Core Utilities
 *
 * Pure utility functions for working with canvas data.
 * These functions are platform-agnostic and have no external dependencies.
 */

import type {
  CanvasElement,
  ImageCanvasElement,
  FrameCanvasElement,
  CanvasData,
  ExtractedCanvasData,
} from './types';

/**
 * Sanitize a single element to ensure all numeric fields are actually numbers.
 * AI sometimes passes strings like "700" instead of 700.
 */
export function sanitizeElement(
  el: Partial<CanvasElement> & { type?: string }
): CanvasElement {
  const base = {
    id: el.id || '',
    name: el.name || '',
    x: Number(el.x) || 0,
    y: Number(el.y) || 0,
    width: Number(el.width) || 100,
    height: Number(el.height) || 100,
    rotation: Number(el.rotation) || 0,
    opacity: el.opacity !== undefined ? Number(el.opacity) : 1,
    locked: Boolean(el.locked),
    visible: el.visible !== false,
  };

  if (el.type === 'frame') {
    return {
      ...base,
      type: 'frame',
      backgroundColor:
        (el as Partial<FrameCanvasElement>).backgroundColor || undefined,
    } as FrameCanvasElement;
  }

  // Default to image type
  return {
    ...base,
    type: 'image',
    src: (el as Partial<ImageCanvasElement>).src || '',
    scaleX: Number((el as Partial<ImageCanvasElement>).scaleX) || 1,
    scaleY: Number((el as Partial<ImageCanvasElement>).scaleY) || 1,
  } as ImageCanvasElement;
}

/**
 * Sanitize an array of elements.
 */
export function sanitizeElements(
  elements: (Partial<CanvasElement> & { type?: string })[]
): CanvasElement[] {
  return (elements || []).map(sanitizeElement);
}

/**
 * Check if a file path is a canvas file (.kanvax).
 */
export function isCanvasFile(filePath: string): boolean {
  if (!filePath) return false;
  return (
    /\.kanvax$/i.test(filePath) || /canvases\/[^\/]+\.kanvax$/i.test(filePath)
  );
}

/**
 * Parse canvas file path to extract canvas name.
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
      canvasName: match[1],
    };
  }

  return { isValid: false, canvasName: null };
}

// Type for tool call data (generic to avoid dependency on specific implementations)
type ToolCallLike = {
  name?: string;
  arguments?: Record<string, any>;
  metadata?: any;
} | null;

// Type for tool result data
type ToolResultLike = {
  output?: any;
  success?: boolean;
} | null;

/**
 * Extract canvas data from tool call and result.
 * Used by tool views to display canvas information.
 */
export function extractCanvasData(
  toolCall: ToolCallLike,
  toolResult: ToolResultLike,
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
      // Failed to parse tool result
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
  const sandbox_id =
    parsedResult?.sandbox_id || (toolCall as any).metadata?.sandbox_id;

  return {
    canvasName,
    canvasPath,
    canvasData: parsedResult?.canvas_data || null,
    background,
    totalElements:
      parsedResult?.total_elements || parsedResult?.element_count || 0,
    status,
    error,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
    sandbox_id,
  };
}

/**
 * Create an empty canvas data structure.
 */
export function createEmptyCanvas(name: string): CanvasData {
  return {
    name: name.replace('.kanvax', ''),
    version: '1.0',
    background: 'var(--background)',
    description: '',
    elements: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Parse canvas content JSON safely.
 * Returns null if parsing fails.
 */
export function parseCanvasContent(content: string): CanvasData | null {
  try {
    return JSON.parse(content) as CanvasData;
  } catch {
    return null;
  }
}

/**
 * Serialize canvas data to JSON string.
 */
export function serializeCanvasData(data: CanvasData): string {
  return JSON.stringify(data, null, 2);
}
