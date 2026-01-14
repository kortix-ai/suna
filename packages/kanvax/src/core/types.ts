/**
 * @agentpress/kanvax - Core Types
 *
 * Canvas element types and data structures for the Kanvax canvas system.
 * These types are platform-agnostic and can be used in web, mobile, or backend.
 */

// OCR detected text region with polygon bounding box
export interface TextRegion {
  id: string;
  text: string;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  polygon: [number, number][]; // [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] - perspective-aware corners
  confidence: number;
}

// Base element properties shared by all element types
export interface BaseCanvasElement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
  name: string;
  visible?: boolean;
}

// Image element - has src for image data
export interface ImageCanvasElement extends BaseCanvasElement {
  type: 'image';
  src: string;
  scaleX?: number;
  scaleY?: number;
}

// Frame element - container/viewport for exporting, no src needed
export interface FrameCanvasElement extends BaseCanvasElement {
  type: 'frame';
  backgroundColor?: string; // Optional fill color, default transparent
}

// Union type for all canvas elements
export type CanvasElement = ImageCanvasElement | FrameCanvasElement;

// Snap guide for visual alignment feedback
export interface SnapGuide {
  type: 'vertical' | 'horizontal';
  position: number; // Canvas coordinate (not screen)
  frameId: string; // Which frame this guide belongs to
}

// Canvas document structure
export interface CanvasData {
  name: string;
  version: string;
  background: string;
  elements: CanvasElement[];
  width?: number;  // Optional - canvas is infinite
  height?: number; // Optional - canvas is infinite
  description?: string;
  created_at?: string;
  updated_at?: string;
}

// Extracted canvas data from tool calls
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

// Props for the canvas renderer component
export interface CanvasRendererProps {
  content: string | null;
  filePath?: string;
  fileName: string;
  sandboxId?: string;
  className?: string;
  onSave?: (content: string) => Promise<void>;
}
