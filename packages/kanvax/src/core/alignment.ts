/**
 * @agentpress/kanvax - Alignment & Layout Logic
 *
 * Advanced alignment, distribution, and layout algorithms.
 * All functions are pure and platform-agnostic.
 */

import type { CanvasElement, FrameCanvasElement, SnapGuide } from './types';

// ============================================================================
// TYPES
// ============================================================================

export type AlignmentType =
  | 'left'
  | 'center'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom';

export type DistributeType = 'horizontal' | 'vertical';

export type LayoutType = 'masonry' | 'bento' | 'grid';

/** Extended snap guide with strength indicator */
export interface AlignmentGuide extends SnapGuide {
  /** 'potential' = dashed line (can snap), 'active' = solid line (will snap) */
  strength: 'potential' | 'active';
  /** Source of this guide */
  source: 'element-edge' | 'element-center' | 'frame-edge' | 'frame-center' | 'equal-spacing';
  /** ID of the source element */
  sourceId: string;
}

export interface AlignmentResult {
  /** Snapped X position (null if no snap) */
  snapX: number | null;
  /** Snapped Y position (null if no snap) */
  snapY: number | null;
  /** All alignment guides to display */
  guides: AlignmentGuide[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Threshold for showing potential alignment (dashed guides) */
export const POTENTIAL_SNAP_THRESHOLD = 24;

/** Threshold for active snapping (solid guides) */
export const ACTIVE_SNAP_THRESHOLD = 8;

/** Minimum gap for equal spacing detection */
export const MIN_SPACING_GAP = 20;

// ============================================================================
// ADVANCED ALIGNMENT DETECTION
// ============================================================================

/**
 * Calculate all alignment guides for a dragged element.
 * Checks alignment against all other elements and frames.
 */
export function calculateAlignmentGuides(
  draggedElement: { x: number; y: number; width: number; height: number; id: string },
  allElements: CanvasElement[],
  frames: FrameCanvasElement[]
): AlignmentResult {
  const guides: AlignmentGuide[] = [];
  let snapX: number | null = null;
  let snapY: number | null = null;

  const draggedCenterX = draggedElement.x + draggedElement.width / 2;
  const draggedCenterY = draggedElement.y + draggedElement.height / 2;
  const draggedLeft = draggedElement.x;
  const draggedRight = draggedElement.x + draggedElement.width;
  const draggedTop = draggedElement.y;
  const draggedBottom = draggedElement.y + draggedElement.height;

  // Check against other elements
  for (const el of allElements) {
    if (el.id === draggedElement.id) continue;

    const elCenterX = el.x + el.width / 2;
    const elCenterY = el.y + el.height / 2;
    const elLeft = el.x;
    const elRight = el.x + el.width;
    const elTop = el.y;
    const elBottom = el.y + el.height;

    // Vertical alignments (X positions)
    const verticalChecks = [
      { draggedPos: draggedLeft, elPos: elLeft, type: 'element-edge' as const, label: 'left-left' },
      { draggedPos: draggedRight, elPos: elRight, type: 'element-edge' as const, label: 'right-right' },
      { draggedPos: draggedLeft, elPos: elRight, type: 'element-edge' as const, label: 'left-right' },
      { draggedPos: draggedRight, elPos: elLeft, type: 'element-edge' as const, label: 'right-left' },
      { draggedPos: draggedCenterX, elPos: elCenterX, type: 'element-center' as const, label: 'center-center' },
    ];

    for (const check of verticalChecks) {
      const distance = Math.abs(check.draggedPos - check.elPos);
      if (distance < POTENTIAL_SNAP_THRESHOLD) {
        const strength = distance < ACTIVE_SNAP_THRESHOLD ? 'active' : 'potential';
        guides.push({
          type: 'vertical',
          position: check.elPos,
          frameId: el.id,
          strength,
          source: check.type,
          sourceId: el.id,
        });
        if (strength === 'active' && snapX === null) {
          // Adjust position based on which edge is snapping
          if (check.label.startsWith('left')) {
            snapX = check.elPos;
          } else if (check.label.startsWith('right')) {
            snapX = check.elPos - draggedElement.width;
          } else {
            snapX = check.elPos - draggedElement.width / 2;
          }
        }
      }
    }

    // Horizontal alignments (Y positions)
    const horizontalChecks = [
      { draggedPos: draggedTop, elPos: elTop, type: 'element-edge' as const, label: 'top-top' },
      { draggedPos: draggedBottom, elPos: elBottom, type: 'element-edge' as const, label: 'bottom-bottom' },
      { draggedPos: draggedTop, elPos: elBottom, type: 'element-edge' as const, label: 'top-bottom' },
      { draggedPos: draggedBottom, elPos: elTop, type: 'element-edge' as const, label: 'bottom-top' },
      { draggedPos: draggedCenterY, elPos: elCenterY, type: 'element-center' as const, label: 'middle-middle' },
    ];

    for (const check of horizontalChecks) {
      const distance = Math.abs(check.draggedPos - check.elPos);
      if (distance < POTENTIAL_SNAP_THRESHOLD) {
        const strength = distance < ACTIVE_SNAP_THRESHOLD ? 'active' : 'potential';
        guides.push({
          type: 'horizontal',
          position: check.elPos,
          frameId: el.id,
          strength,
          source: check.type,
          sourceId: el.id,
        });
        if (strength === 'active' && snapY === null) {
          if (check.label.startsWith('top')) {
            snapY = check.elPos;
          } else if (check.label.startsWith('bottom')) {
            snapY = check.elPos - draggedElement.height;
          } else {
            snapY = check.elPos - draggedElement.height / 2;
          }
        }
      }
    }
  }

  // Check against frames (higher priority)
  for (const frame of frames) {
    if (frame.id === draggedElement.id) continue;

    const frameCenterX = frame.x + frame.width / 2;
    const frameCenterY = frame.y + frame.height / 2;

    // Frame center alignment
    const distX = Math.abs(draggedCenterX - frameCenterX);
    if (distX < POTENTIAL_SNAP_THRESHOLD) {
      const strength = distX < ACTIVE_SNAP_THRESHOLD ? 'active' : 'potential';
      guides.push({
        type: 'vertical',
        position: frameCenterX,
        frameId: frame.id,
        strength,
        source: 'frame-center',
        sourceId: frame.id,
      });
      if (strength === 'active' && snapX === null) {
        snapX = frameCenterX - draggedElement.width / 2;
      }
    }

    const distY = Math.abs(draggedCenterY - frameCenterY);
    if (distY < POTENTIAL_SNAP_THRESHOLD) {
      const strength = distY < ACTIVE_SNAP_THRESHOLD ? 'active' : 'potential';
      guides.push({
        type: 'horizontal',
        position: frameCenterY,
        frameId: frame.id,
        strength,
        source: 'frame-center',
        sourceId: frame.id,
      });
      if (strength === 'active' && snapY === null) {
        snapY = frameCenterY - draggedElement.height / 2;
      }
    }

    // Frame edge alignment
    const frameEdges = [
      { pos: frame.x, type: 'vertical' as const },
      { pos: frame.x + frame.width, type: 'vertical' as const },
      { pos: frame.y, type: 'horizontal' as const },
      { pos: frame.y + frame.height, type: 'horizontal' as const },
    ];

    for (const edge of frameEdges) {
      const draggedPos = edge.type === 'vertical'
        ? [draggedLeft, draggedRight, draggedCenterX]
        : [draggedTop, draggedBottom, draggedCenterY];

      for (const pos of draggedPos) {
        const dist = Math.abs(pos - edge.pos);
        if (dist < POTENTIAL_SNAP_THRESHOLD) {
          const strength = dist < ACTIVE_SNAP_THRESHOLD ? 'active' : 'potential';
          guides.push({
            type: edge.type,
            position: edge.pos,
            frameId: frame.id,
            strength,
            source: 'frame-edge',
            sourceId: frame.id,
          });
        }
      }
    }
  }

  // Deduplicate guides (keep highest strength for same position)
  const uniqueGuides = deduplicateGuides(guides);

  return { snapX, snapY, guides: uniqueGuides };
}

/** Remove duplicate guides, keeping the highest strength */
function deduplicateGuides(guides: AlignmentGuide[]): AlignmentGuide[] {
  const map = new Map<string, AlignmentGuide>();

  for (const guide of guides) {
    const key = `${guide.type}-${Math.round(guide.position)}`;
    const existing = map.get(key);

    if (!existing || (guide.strength === 'active' && existing.strength === 'potential')) {
      map.set(key, guide);
    }
  }

  return Array.from(map.values());
}

// ============================================================================
// ALIGNMENT OPERATIONS
// ============================================================================

export interface ElementUpdate {
  id: string;
  x: number;
  y: number;
}

/**
 * Align selected elements.
 */
export function alignElements(
  elements: CanvasElement[],
  alignment: AlignmentType
): ElementUpdate[] {
  if (elements.length < 2) return [];

  // Calculate bounds
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const el of elements) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return elements.map((el) => {
    let newX = el.x;
    let newY = el.y;

    switch (alignment) {
      case 'left':
        newX = minX;
        break;
      case 'center':
        newX = centerX - el.width / 2;
        break;
      case 'right':
        newX = maxX - el.width;
        break;
      case 'top':
        newY = minY;
        break;
      case 'middle':
        newY = centerY - el.height / 2;
        break;
      case 'bottom':
        newY = maxY - el.height;
        break;
    }

    return { id: el.id, x: newX, y: newY };
  });
}

/**
 * Distribute elements evenly.
 */
export function distributeElements(
  elements: CanvasElement[],
  direction: DistributeType
): ElementUpdate[] {
  if (elements.length < 3) return [];

  // Sort elements by position
  const sorted = [...elements].sort((a, b) =>
    direction === 'horizontal' ? a.x - b.x : a.y - b.y
  );

  // Calculate total space and gap
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (direction === 'horizontal') {
    const totalSpace = (last.x + last.width) - first.x;
    const totalElementWidth = elements.reduce((sum, el) => sum + el.width, 0);
    const gap = (totalSpace - totalElementWidth) / (elements.length - 1);

    let currentX = first.x;
    return sorted.map((el) => {
      const update = { id: el.id, x: currentX, y: el.y };
      currentX += el.width + gap;
      return update;
    });
  } else {
    const totalSpace = (last.y + last.height) - first.y;
    const totalElementHeight = elements.reduce((sum, el) => sum + el.height, 0);
    const gap = (totalSpace - totalElementHeight) / (elements.length - 1);

    let currentY = first.y;
    return sorted.map((el) => {
      const update = { id: el.id, x: el.x, y: currentY };
      currentY += el.height + gap;
      return update;
    });
  }
}

// ============================================================================
// LAYOUT ALGORITHMS
// ============================================================================

export interface LayoutOptions {
  /** Gap between elements */
  gap?: number;
  /** Number of columns (for grid/masonry) */
  columns?: number;
  /** Starting X position */
  startX?: number;
  /** Starting Y position */
  startY?: number;
  /** Maximum width for the layout */
  maxWidth?: number;
}

/**
 * Apply masonry layout to elements.
 * Elements are placed in columns, filling the shortest column first.
 */
export function applyMasonryLayout(
  elements: CanvasElement[],
  options: LayoutOptions = {}
): ElementUpdate[] {
  const {
    gap = 16,
    columns = 2,
    startX = 0,
    startY = 0,
    maxWidth,
  } = options;

  if (elements.length === 0) return [];

  // Calculate column width based on average element width or maxWidth
  const avgWidth = elements.reduce((sum, el) => sum + el.width, 0) / elements.length;
  const columnWidth = maxWidth
    ? (maxWidth - gap * (columns - 1)) / columns
    : avgWidth;

  // Track the bottom of each column
  const columnBottoms = new Array(columns).fill(startY);

  return elements.map((el) => {
    // Find the shortest column
    const shortestColumn = columnBottoms.indexOf(Math.min(...columnBottoms));

    // Calculate position
    const x = startX + shortestColumn * (columnWidth + gap);
    const y = columnBottoms[shortestColumn];

    // Scale element to fit column width while preserving aspect ratio
    const scale = columnWidth / el.width;
    const scaledHeight = el.height * scale;

    // Update column bottom
    columnBottoms[shortestColumn] = y + scaledHeight + gap;

    return { id: el.id, x, y };
  });
}

/**
 * Apply bento grid layout to elements.
 * Creates a visually interesting grid with varied sizes.
 */
export function applyBentoLayout(
  elements: CanvasElement[],
  options: LayoutOptions = {}
): ElementUpdate[] {
  const {
    gap = 16,
    startX = 0,
    startY = 0,
    maxWidth = 800,
  } = options;

  if (elements.length === 0) return [];

  // Bento patterns for different element counts
  const updates: ElementUpdate[] = [];
  const unitWidth = (maxWidth - gap) / 2;
  const unitHeight = unitWidth * 0.75; // 4:3 aspect ratio for units

  // Simple bento pattern
  let row = 0;
  let col = 0;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    // Alternate between full-width and half-width items
    const isLarge = i % 3 === 0 && i < elements.length - 1;

    if (isLarge) {
      // Full width item
      updates.push({
        id: el.id,
        x: startX,
        y: startY + row * (unitHeight + gap),
      });
      row++;
      col = 0;
    } else {
      // Half width item
      updates.push({
        id: el.id,
        x: startX + col * (unitWidth + gap),
        y: startY + row * (unitHeight + gap),
      });
      col++;
      if (col >= 2) {
        col = 0;
        row++;
      }
    }
  }

  return updates;
}

/**
 * Apply simple grid layout to elements.
 */
export function applyGridLayout(
  elements: CanvasElement[],
  options: LayoutOptions = {}
): ElementUpdate[] {
  const {
    gap = 16,
    columns = 3,
    startX = 0,
    startY = 0,
  } = options;

  if (elements.length === 0) return [];

  // Use the largest element dimensions for consistent grid
  const maxElementWidth = Math.max(...elements.map(el => el.width));
  const maxElementHeight = Math.max(...elements.map(el => el.height));

  return elements.map((el, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);

    return {
      id: el.id,
      x: startX + col * (maxElementWidth + gap),
      y: startY + row * (maxElementHeight + gap),
    };
  });
}

// ============================================================================
// ANIMATION HELPERS
// ============================================================================

/**
 * Calculate animated position for smooth transitions.
 * Uses spring-like easing for snappy feel.
 */
export function interpolatePosition(
  current: { x: number; y: number },
  target: { x: number; y: number },
  progress: number // 0 to 1
): { x: number; y: number } {
  // Spring-like easing function for snappy animation
  const ease = (t: number) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  };

  const easedProgress = ease(progress);

  return {
    x: current.x + (target.x - current.x) * easedProgress,
    y: current.y + (target.y - current.y) * easedProgress,
  };
}

/**
 * Check if an animation is effectively complete (within threshold).
 */
export function isAnimationComplete(
  current: { x: number; y: number },
  target: { x: number; y: number },
  threshold: number = 0.5
): boolean {
  return (
    Math.abs(current.x - target.x) < threshold &&
    Math.abs(current.y - target.y) < threshold
  );
}
