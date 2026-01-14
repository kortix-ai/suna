/**
 * @agentpress/kanvax - Canvas Logic
 *
 * Pure calculation and logic functions for canvas operations.
 * These are platform-agnostic and have no UI or framework dependencies.
 */

import type {
  CanvasElement,
  FrameCanvasElement,
  SnapGuide,
} from './types';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Pixels threshold for snapping (in canvas coordinates) */
export const SNAP_THRESHOLD = 12;

/** Default padding for image placement */
export const IMAGE_PLACEMENT_PADDING = 24;

/** Minimum element size for resize operations */
export const MIN_ELEMENT_SIZE = 50;

/** Minimum frame size for resize operations */
export const MIN_FRAME_SIZE = 100;

// ============================================================================
// COORDINATE CONVERSIONS
// ============================================================================

export interface StagePosition {
  x: number;
  y: number;
}

/**
 * Convert canvas coordinates to screen coordinates.
 */
export function canvasToScreen(
  canvasX: number,
  canvasY: number,
  scale: number,
  stagePosition: StagePosition
): { x: number; y: number } {
  return {
    x: canvasX * scale + stagePosition.x,
    y: canvasY * scale + stagePosition.y,
  };
}

/**
 * Convert screen coordinates to canvas coordinates.
 */
export function screenToCanvas(
  screenX: number,
  screenY: number,
  scale: number,
  stagePosition: StagePosition
): { x: number; y: number } {
  return {
    x: (screenX - stagePosition.x) / scale,
    y: (screenY - stagePosition.y) / scale,
  };
}

/**
 * Calculate element position in screen coordinates.
 */
export function getElementScreenPosition(
  element: CanvasElement,
  scale: number,
  stagePosition: StagePosition
): { x: number; y: number; width: number; height: number } {
  return {
    x: element.x * scale + stagePosition.x,
    y: element.y * scale + stagePosition.y,
    width: element.width * scale,
    height: element.height * scale,
  };
}

// ============================================================================
// SNAP CALCULATIONS
// ============================================================================

export interface SnapResult {
  snapX: number | null;
  snapY: number | null;
  guides: SnapGuide[];
}

/**
 * Calculate snap guides and snapped position for an element.
 * Checks alignment against frame centers.
 */
export function calculateSnapResult(
  elemCenterX: number,
  elemCenterY: number,
  frames: FrameCanvasElement[],
  excludeFrameId?: string,
  threshold: number = SNAP_THRESHOLD
): SnapResult {
  let snapX: number | null = null;
  let snapY: number | null = null;
  const guides: SnapGuide[] = [];

  for (const frame of frames) {
    if (frame.id === excludeFrameId) continue;

    const frameCenterX = frame.x + frame.width / 2;
    const frameCenterY = frame.y + frame.height / 2;

    // Check vertical center alignment (element center X == frame center X)
    if (Math.abs(elemCenterX - frameCenterX) < threshold) {
      snapX = frameCenterX;
      guides.push({
        type: 'vertical',
        position: frameCenterX,
        frameId: frame.id,
      });
    }

    // Check horizontal center alignment (element center Y == frame center Y)
    if (Math.abs(elemCenterY - frameCenterY) < threshold) {
      snapY = frameCenterY;
      guides.push({
        type: 'horizontal',
        position: frameCenterY,
        frameId: frame.id,
      });
    }
  }

  return { snapX, snapY, guides };
}

/**
 * Apply snap result to element position.
 * Returns adjusted position with element center aligned to snap point.
 */
export function applySnapToPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  snapResult: SnapResult
): { x: number; y: number } {
  let newX = x;
  let newY = y;

  if (snapResult.snapX !== null) {
    newX = snapResult.snapX - width / 2;
  }
  if (snapResult.snapY !== null) {
    newY = snapResult.snapY - height / 2;
  }

  return { x: newX, y: newY };
}

// ============================================================================
// BOUNDS CALCULATIONS
// ============================================================================

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ContentBounds extends Bounds {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/**
 * Calculate the bounding box of all elements.
 * Returns null if no elements.
 */
export function getContentBounds(elements: CanvasElement[]): ContentBounds | null {
  if (elements.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of elements) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }

  const width = maxX - minX;
  const height = maxY - minY;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2,
  };
}

/**
 * Calculate scale to fit content within container.
 * Returns scale clamped to reasonable bounds.
 */
export function calculateFitScale(
  contentWidth: number,
  contentHeight: number,
  containerWidth: number,
  containerHeight: number,
  padding: number = 0.8,
  minScale: number = 0.15,
  maxScale: number = 1
): number {
  const scaleX = (containerWidth * padding) / contentWidth;
  const scaleY = (containerHeight * padding) / contentHeight;
  const fitScale = Math.min(scaleX, scaleY, maxScale);
  return Math.max(fitScale, minScale);
}

/**
 * Calculate stage position to center content.
 */
export function calculateCenterPosition(
  contentCenterX: number,
  contentCenterY: number,
  containerWidth: number,
  containerHeight: number,
  scale: number
): StagePosition {
  return {
    x: containerWidth / 2 - contentCenterX * scale,
    y: containerHeight / 2 - contentCenterY * scale,
  };
}

// ============================================================================
// ELEMENT POSITION UTILITIES
// ============================================================================

/**
 * Find elements that intersect with a selection rectangle.
 * Coordinates should be in screen space.
 */
export function findElementsInSelection(
  elements: CanvasElement[],
  selectionRect: { x: number; y: number; w: number; h: number },
  scale: number,
  stagePosition: StagePosition
): string[] {
  const selected: string[] = [];

  for (const el of elements) {
    const elLeft = el.x * scale + stagePosition.x;
    const elTop = el.y * scale + stagePosition.y;
    const elRight = elLeft + el.width * scale;
    const elBottom = elTop + el.height * scale;

    const selRight = selectionRect.x + selectionRect.w;
    const selBottom = selectionRect.y + selectionRect.h;

    // Check if rectangles overlap
    if (
      elLeft < selRight &&
      elRight > selectionRect.x &&
      elTop < selBottom &&
      elBottom > selectionRect.y
    ) {
      selected.push(el.id);
    }
  }

  return selected;
}

/**
 * Find elements inside a frame (by overlap).
 * Returns elements that overlap with the frame bounds.
 */
export function findElementsInFrame(
  elements: CanvasElement[],
  frame: FrameCanvasElement
): CanvasElement[] {
  const frameRight = frame.x + frame.width;
  const frameBottom = frame.y + frame.height;

  return elements.filter((el) => {
    if (el.id === frame.id || el.type === 'frame') return false;

    const elRight = el.x + el.width;
    const elBottom = el.y + el.height;

    // Check if element overlaps with frame
    return (
      el.x < frameRight &&
      elRight > frame.x &&
      el.y < frameBottom &&
      elBottom > frame.y
    );
  });
}

/**
 * Calculate next image position based on existing elements.
 * Places image to the right of the rightmost element.
 */
export function getNextImagePosition(
  elements: CanvasElement[],
  containerWidth: number,
  containerHeight: number,
  stagePosition: StagePosition,
  scale: number,
  imgWidth: number,
  imgHeight: number,
  padding: number = IMAGE_PLACEMENT_PADDING
): { x: number; y: number } {
  if (elements.length === 0) {
    // First image - center in visible area
    const centerX =
      (containerWidth / 2 - stagePosition.x) / scale - imgWidth / 2;
    const centerY =
      (containerHeight / 2 - stagePosition.y) / scale - imgHeight / 2;
    return { x: centerX, y: centerY };
  }

  // Find the rightmost edge of existing elements
  let maxRight = -Infinity;
  let topAtMaxRight = 0;

  for (const el of elements) {
    const right = el.x + el.width;
    if (right > maxRight) {
      maxRight = right;
      topAtMaxRight = el.y;
    }
  }

  // Place new image to the right of the rightmost element with padding
  return { x: maxRight + padding, y: topAtMaxRight };
}

// ============================================================================
// RESIZE CALCULATIONS
// ============================================================================

export type ResizeHandle =
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'ne'
  | 'nw'
  | 'se'
  | 'sw';

export interface ResizeResult {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Calculate resize with aspect ratio preservation (for images).
 * Uses dominant axis to determine resize direction.
 */
export function calculateAspectRatioResize(
  handle: ResizeHandle,
  dx: number,
  dy: number,
  startX: number,
  startY: number,
  startWidth: number,
  startHeight: number,
  minSize: number = MIN_ELEMENT_SIZE
): ResizeResult {
  const aspectRatio = startWidth / startHeight;
  let newX = startX;
  let newY = startY;
  let newW = startWidth;
  let newH = startHeight;

  switch (handle) {
    case 'se':
      if (Math.abs(dx) > Math.abs(dy)) {
        newW = Math.max(minSize, startWidth + dx);
        newH = newW / aspectRatio;
      } else {
        newH = Math.max(minSize, startHeight + dy);
        newW = newH * aspectRatio;
      }
      break;

    case 'sw':
      if (Math.abs(dx) > Math.abs(dy)) {
        newW = Math.max(minSize, startWidth - dx);
        newH = newW / aspectRatio;
        newX = startX + (startWidth - newW);
      } else {
        newH = Math.max(minSize, startHeight + dy);
        newW = newH * aspectRatio;
        newX = startX + (startWidth - newW);
      }
      break;

    case 'ne':
      if (Math.abs(dx) > Math.abs(dy)) {
        newW = Math.max(minSize, startWidth + dx);
        newH = newW / aspectRatio;
        newY = startY + (startHeight - newH);
      } else {
        newH = Math.max(minSize, startHeight - dy);
        newW = newH * aspectRatio;
        newY = startY + (startHeight - newH);
      }
      break;

    case 'nw':
      if (Math.abs(dx) > Math.abs(dy)) {
        newW = Math.max(minSize, startWidth - dx);
        newH = newW / aspectRatio;
        newX = startX + (startWidth - newW);
        newY = startY + (startHeight - newH);
      } else {
        newH = Math.max(minSize, startHeight - dy);
        newW = newH * aspectRatio;
        newX = startX + (startWidth - newW);
        newY = startY + (startHeight - newH);
      }
      break;

    case 'e':
      newW = Math.max(minSize, startWidth + dx);
      newH = newW / aspectRatio;
      newY = startY + (startHeight - newH) / 2;
      break;

    case 'w':
      newW = Math.max(minSize, startWidth - dx);
      newH = newW / aspectRatio;
      newX = startX + (startWidth - newW);
      newY = startY + (startHeight - newH) / 2;
      break;

    case 's':
      newH = Math.max(minSize, startHeight + dy);
      newW = newH * aspectRatio;
      newX = startX + (startWidth - newW) / 2;
      break;

    case 'n':
      newH = Math.max(minSize, startHeight - dy);
      newW = newH * aspectRatio;
      newX = startX + (startWidth - newW) / 2;
      newY = startY + (startHeight - newH);
      break;
  }

  return { x: newX, y: newY, width: newW, height: newH };
}

/**
 * Calculate resize without aspect ratio constraint (for frames).
 */
export function calculateFreeResize(
  handle: ResizeHandle,
  dx: number,
  dy: number,
  startX: number,
  startY: number,
  startWidth: number,
  startHeight: number,
  minSize: number = MIN_FRAME_SIZE
): ResizeResult {
  let newX = startX;
  let newY = startY;
  let newW = startWidth;
  let newH = startHeight;

  switch (handle) {
    case 'se':
      newW = Math.max(minSize, startWidth + dx);
      newH = Math.max(minSize, startHeight + dy);
      break;

    case 'sw':
      newW = Math.max(minSize, startWidth - dx);
      newH = Math.max(minSize, startHeight + dy);
      newX = startX + (startWidth - newW);
      break;

    case 'ne':
      newW = Math.max(minSize, startWidth + dx);
      newH = Math.max(minSize, startHeight - dy);
      newY = startY + (startHeight - newH);
      break;

    case 'nw':
      newW = Math.max(minSize, startWidth - dx);
      newH = Math.max(minSize, startHeight - dy);
      newX = startX + (startWidth - newW);
      newY = startY + (startHeight - newH);
      break;

    case 'e':
      newW = Math.max(minSize, startWidth + dx);
      break;

    case 'w':
      newW = Math.max(minSize, startWidth - dx);
      newX = startX + (startWidth - newW);
      break;

    case 's':
      newH = Math.max(minSize, startHeight + dy);
      break;

    case 'n':
      newH = Math.max(minSize, startHeight - dy);
      newY = startY + (startHeight - newH);
      break;
  }

  return { x: newX, y: newY, width: newW, height: newH };
}

// ============================================================================
// ZOOM CALCULATIONS
// ============================================================================

/**
 * Calculate new scale and position for zoom towards a point.
 */
export function calculateZoomToPoint(
  mouseX: number,
  mouseY: number,
  currentScale: number,
  currentPosition: StagePosition,
  deltaY: number,
  sensitivity: number = 0.01,
  minScale: number = 0.1,
  maxScale: number = 5
): { scale: number; position: StagePosition } {
  const zoomFactor = 1 - deltaY * sensitivity;
  const newScale = Math.max(minScale, Math.min(maxScale, currentScale * zoomFactor));

  const scaleRatio = newScale / currentScale;
  const newPosX = mouseX - (mouseX - currentPosition.x) * scaleRatio;
  const newPosY = mouseY - (mouseY - currentPosition.y) * scaleRatio;

  return {
    scale: newScale,
    position: { x: newPosX, y: newPosY },
  };
}

// ============================================================================
// PATH UTILITIES
// ============================================================================

/**
 * Normalize a file path for sandbox access.
 * Ensures path starts with /workspace/.
 */
export function normalizeSandboxPath(path: string): string {
  let normalizedPath = path;
  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.substring(1);
  }
  if (normalizedPath.startsWith('workspace/')) {
    normalizedPath = normalizedPath.substring(10);
  }
  return `/workspace/${normalizedPath}`;
}

/**
 * Build sandbox file URL.
 * @param baseUrl - The backend base URL
 * @param sandboxId - The sandbox ID
 * @param path - The file path
 */
export function buildSandboxFileUrl(
  baseUrl: string,
  sandboxId: string,
  path: string
): string {
  const normalizedPath = normalizeSandboxPath(path);
  return `${baseUrl}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(normalizedPath)}`;
}

// ============================================================================
// IMAGE SCALING
// ============================================================================

/**
 * Calculate scaled dimensions while preserving aspect ratio.
 * Used for limiting image size on paste/upload.
 */
export function calculateScaledDimensions(
  width: number,
  height: number,
  maxSize: number
): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) {
    return { width, height };
  }

  const scaleFactor = Math.min(maxSize / width, maxSize / height);
  return {
    width: Math.round(width * scaleFactor),
    height: Math.round(height * scaleFactor),
  };
}

// ============================================================================
// CLIP PATH CALCULATIONS
// ============================================================================

/**
 * Calculate CSS clip-path for an image element relative to a frame.
 * Returns polygon clip-path string or null if no clipping needed.
 */
export function calculateClipPath(
  imageElement: CanvasElement,
  frame: FrameCanvasElement,
  scale: number,
  stagePosition: StagePosition
): string | null {
  // Get image screen bounds
  const imgScreen = getElementScreenPosition(imageElement, scale, stagePosition);

  // Get frame screen bounds
  const frameLeft = frame.x * scale + stagePosition.x;
  const frameTop = frame.y * scale + stagePosition.y;
  const frameRight = frameLeft + frame.width * scale;
  const frameBottom = frameTop + frame.height * scale;

  // Calculate clip rect relative to image element (0-100%)
  const clipLeft = Math.max(0, ((frameLeft - imgScreen.x) / imgScreen.width) * 100);
  const clipTop = Math.max(0, ((frameTop - imgScreen.y) / imgScreen.height) * 100);
  const clipRight = Math.min(100, ((frameRight - imgScreen.x) / imgScreen.width) * 100);
  const clipBottom = Math.min(100, ((frameBottom - imgScreen.y) / imgScreen.height) * 100);

  // Only clip if actually constrained
  if (clipLeft > 0 || clipTop > 0 || clipRight < 100 || clipBottom < 100) {
    return `polygon(${clipLeft}% ${clipTop}%, ${clipRight}% ${clipTop}%, ${clipRight}% ${clipBottom}%, ${clipLeft}% ${clipBottom}%)`;
  }

  return null;
}

/**
 * Check if an image element overlaps with a frame.
 */
export function doesElementOverlapFrame(
  element: CanvasElement,
  frame: FrameCanvasElement
): boolean {
  const elRight = element.x + element.width;
  const elBottom = element.y + element.height;
  const frameRight = frame.x + frame.width;
  const frameBottom = frame.y + frame.height;

  return (
    element.x < frameRight &&
    elRight > frame.x &&
    element.y < frameBottom &&
    elBottom > frame.y
  );
}
