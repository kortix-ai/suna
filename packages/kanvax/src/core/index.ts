/**
 * @agentpress/kanvax/core
 *
 * Core types and utilities for the Kanvax canvas system.
 * Platform-agnostic - can be used in web, mobile, or backend.
 */

// Export all types
export type {
  TextRegion,
  BaseCanvasElement,
  ImageCanvasElement,
  FrameCanvasElement,
  CanvasElement,
  SnapGuide,
  CanvasData,
  ExtractedCanvasData,
  CanvasRendererProps,
} from './types';

// Export all basic utilities
export {
  sanitizeElement,
  sanitizeElements,
  isCanvasFile,
  parseCanvasFilePath,
  extractCanvasData,
  createEmptyCanvas,
  parseCanvasContent,
  serializeCanvasData,
} from './utils';

// Export canvas logic types
export type {
  StagePosition,
  SnapResult,
  Bounds,
  ContentBounds,
  ResizeHandle,
  ResizeResult,
} from './canvas-logic';

// Export canvas logic constants and functions
export {
  // Constants
  SNAP_THRESHOLD,
  IMAGE_PLACEMENT_PADDING,
  MIN_ELEMENT_SIZE,
  MIN_FRAME_SIZE,
  // Coordinate conversions
  canvasToScreen,
  screenToCanvas,
  getElementScreenPosition,
  // Snap calculations
  calculateSnapResult,
  applySnapToPosition,
  // Bounds calculations
  getContentBounds,
  calculateFitScale,
  calculateCenterPosition,
  // Element position utilities
  findElementsInSelection,
  findElementsInFrame,
  getNextImagePosition,
  // Resize calculations
  calculateAspectRatioResize,
  calculateFreeResize,
  // Zoom calculations
  calculateZoomToPoint,
  // Path utilities
  normalizeSandboxPath,
  buildSandboxFileUrl,
  // Image scaling
  calculateScaledDimensions,
  // Clip path calculations
  calculateClipPath,
  doesElementOverlapFrame,
} from './canvas-logic';
