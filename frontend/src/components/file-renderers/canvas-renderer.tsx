'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  Minus,
  MousePointer2,
  Hand,
  ImagePlus,
  Maximize,
  Save,
  Loader2,
  AlertCircle,
  Trash2,
  Copy,
  Download,
  Pencil,
  Sparkles,
  X,
  Type,
  Layers,
  ArrowLeftRight,
  Wand2,
  Scissors,
  Frame,
  Palette,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { useAuth } from '@/components/AuthProvider';

// OCR detected text region with polygon bounding box
interface TextRegion {
  id: string;
  text: string;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  polygon: [number, number][]; // [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] - perspective-aware corners
  confidence: number;
}

// Base element properties shared by all element types
interface BaseCanvasElement {
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
interface ImageCanvasElement extends BaseCanvasElement {
  type: 'image';
  src: string;
  scaleX?: number;
  scaleY?: number;
}

// Frame element - container/viewport for exporting, no src needed
interface FrameCanvasElement extends BaseCanvasElement {
  type: 'frame';
  backgroundColor?: string; // Optional fill color, default transparent
}

type CanvasElement = ImageCanvasElement | FrameCanvasElement;

// Snap guide for visual alignment feedback
interface SnapGuide {
  type: 'vertical' | 'horizontal';
  position: number; // Canvas coordinate (not screen)
  frameId: string; // Which frame this guide belongs to
}

interface CanvasData {
  name: string;
  version: string;
  background: string;
  elements: CanvasElement[];
  width?: number;
  height?: number;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

// Sanitize element to ensure all numeric fields are actually numbers
// (AI sometimes passes strings like "700" instead of 700)
function sanitizeElement(el: Partial<CanvasElement> & { type?: string }): CanvasElement {
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
      backgroundColor: (el as Partial<FrameCanvasElement>).backgroundColor || undefined,
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

function sanitizeElements(elements: (Partial<CanvasElement> & { type?: string })[]): CanvasElement[] {
  return (elements || []).map(sanitizeElement);
}

interface CanvasRendererProps {
  content: string | null;
  filePath?: string;
  fileName: string;
  sandboxId?: string;
  className?: string;
  onSave?: (content: string) => Promise<void>;
}

function getSandboxFileUrl(sandboxId: string | undefined, path: string): string {
  if (!sandboxId) return path;
  let normalizedPath = path;
  if (normalizedPath.startsWith('/')) normalizedPath = normalizedPath.substring(1);
  if (normalizedPath.startsWith('workspace/')) normalizedPath = normalizedPath.substring(10);
  normalizedPath = `/workspace/${normalizedPath}`;
  const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '';
  return `${baseUrl}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(normalizedPath)}`;
}

// AI Processing Overlay with strong diagonal shimmer waves
function AIProcessingOverlay({ isVisible }: { isVisible: boolean }) {
  if (!isVisible) return null;

  return (
    <div className="absolute inset-0 overflow-hidden rounded pointer-events-none z-20">
      {/* Dim overlay to make shimmer more visible */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Strong diagonal shimmer waves - slower animation */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            linear-gradient(
              110deg, 
              transparent 15%, 
              rgba(255,255,255,0.15) 25%,
              rgba(255,255,255,0.5) 45%,
              rgba(255,255,255,0.7) 50%,
              rgba(255,255,255,0.5) 55%,
              rgba(255,255,255,0.15) 75%,
              transparent 85%
            )
          `,
          backgroundSize: '300% 100%',
          animation: 'shimmer 2.5s infinite linear',
        }}
      />
      {/* Second wave for more intensity - slower */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            linear-gradient(
              110deg, 
              transparent 25%, 
              rgba(255,255,255,0.25) 40%,
              rgba(255,255,255,0.6) 50%,
              rgba(255,255,255,0.25) 60%,
              transparent 75%
            )
          `,
          backgroundSize: '250% 100%',
          animation: 'shimmer 2s infinite linear',
          animationDelay: '0.8s',
        }}
      />

      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

// Snap Guides Overlay - shows alignment lines when dragging near frame centers
function SnapGuidesOverlay({
  guides,
  frames,
  scale,
  stagePosition,
}: {
  guides: SnapGuide[];
  frames: FrameCanvasElement[];
  scale: number;
  stagePosition: { x: number; y: number };
}) {
  if (guides.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 50 }}>
      {guides.map((guide, idx) => {
        const frame = frames.find(f => f.id === guide.frameId);
        if (!frame) return null;

        if (guide.type === 'vertical') {
          // Vertical line at frame center X
          const screenX = guide.position * scale + stagePosition.x;
          const frameTop = frame.y * scale + stagePosition.y;
          const frameBottom = (frame.y + frame.height) * scale + stagePosition.y;

          return (
            <div
              key={`guide-${idx}`}
              style={{
                position: 'absolute',
                left: screenX,
                top: frameTop,
                width: 1,
                height: frameBottom - frameTop,
                backgroundColor: '#ff3366',
                boxShadow: '0 0 4px #ff3366',
              }}
            />
          );
        } else {
          // Horizontal line at frame center Y
          const screenY = guide.position * scale + stagePosition.y;
          const frameLeft = frame.x * scale + stagePosition.x;
          const frameRight = (frame.x + frame.width) * scale + stagePosition.x;

          return (
            <div
              key={`guide-${idx}`}
              style={{
                position: 'absolute',
                left: frameLeft,
                top: screenY,
                width: frameRight - frameLeft,
                height: 1,
                backgroundColor: '#ff3366',
                boxShadow: '0 0 4px #ff3366',
              }}
            />
          );
        }
      })}
    </div>
  );
}

// Calculate snap guides and snapped position for an element
const SNAP_THRESHOLD = 12; // Pixels threshold for snapping (in canvas coords)

function calculateSnapResult(
  elemCenterX: number,
  elemCenterY: number,
  frames: FrameCanvasElement[],
  excludeFrameId?: string
): { snapX: number | null; snapY: number | null; guides: SnapGuide[] } {
  let snapX: number | null = null;
  let snapY: number | null = null;
  const guides: SnapGuide[] = [];

  for (const frame of frames) {
    if (frame.id === excludeFrameId) continue;

    const frameCenterX = frame.x + frame.width / 2;
    const frameCenterY = frame.y + frame.height / 2;

    // Check vertical center alignment (element center X == frame center X)
    if (Math.abs(elemCenterX - frameCenterX) < SNAP_THRESHOLD) {
      snapX = frameCenterX;
      guides.push({ type: 'vertical', position: frameCenterX, frameId: frame.id });
    }

    // Check horizontal center alignment (element center Y == frame center Y)
    if (Math.abs(elemCenterY - frameCenterY) < SNAP_THRESHOLD) {
      snapY = frameCenterY;
      guides.push({ type: 'horizontal', position: frameCenterY, frameId: frame.id });
    }
  }

  return { snapX, snapY, guides };
}

// Image element with drag and resize
function CanvasImageElement({
  element,
  isSelected,
  onSelect,
  onChange,
  sandboxId,
  scale,
  stagePosition,
  authToken,
  isProcessing = false,
  clipPath,
  frames = [],
  onSnapChange,
}: {
  element: ImageCanvasElement;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onChange: (newAttrs: Partial<ImageCanvasElement>) => void;
  sandboxId?: string;
  scale: number;
  stagePosition: { x: number; y: number };
  authToken?: string;
  isProcessing?: boolean;
  clipPath?: string; // CSS clip-path for frame clipping
  frames?: FrameCanvasElement[]; // Available frames for snapping
  onSnapChange?: (guides: SnapGuide[]) => void; // Callback to update snap guides
}) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    type: 'move' | 'resize';
    handle?: string;
    startX: number;
    startY: number;
    startElemX: number;
    startElemY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  useEffect(() => {
    // For temp merge placeholders with no src, just show loading state
    if (!element.src) {
      setLoading(true);
      return;
    }
    if (element.src.startsWith('data:')) {
      setImageSrc(element.src);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 5;

    const loadImage = async () => {
      const url = sandboxId ? getSandboxFileUrl(sandboxId, element.src) : element.src;
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      while (retryCount < maxRetries && !cancelled) {
        try {
          setLoading(true);
          setError(null);
          const response = await fetch(url, { credentials: 'include', headers });
          if (!response.ok) {
            // Retry on 404 (image might not be ready yet) or 5xx
            if ((response.status === 404 || response.status >= 500) && retryCount < maxRetries - 1) {
              retryCount++;
              await new Promise(r => setTimeout(r, 500 * retryCount)); // 500ms, 1s, 1.5s, 2s
              continue;
            }
            throw new Error(`HTTP ${response.status}`);
          }
          const blob = await response.blob();
          if (!cancelled) {
            setImageSrc(URL.createObjectURL(blob));
            setLoading(false);
          }
          return; // Success, exit retry loop
        } catch (err) {
          if (retryCount < maxRetries - 1 && !cancelled) {
            retryCount++;
            await new Promise(r => setTimeout(r, 500 * retryCount));
            continue;
          }
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Failed');
            setLoading(false);
          }
          return;
        }
      }
    };
    loadImage();

    return () => { cancelled = true; };
  }, [element.src, sandboxId, authToken]);

  const posX = element.x * scale + stagePosition.x;
  const posY = element.y * scale + stagePosition.y;
  const width = element.width * scale;
  const height = element.height * scale;

  const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'resize' = 'move', handle?: string) => {
    if (element.locked && type === 'move') return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(e);
    setDragState({
      type,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startElemX: element.x,
      startElemY: element.y,
      startWidth: element.width,
      startHeight: element.height,
    });
  };

  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragState.startX) / scale;
      const dy = (e.clientY - dragState.startY) / scale;

      if (dragState.type === 'move') {
        let newX = dragState.startElemX + dx;
        let newY = dragState.startElemY + dy;

        // Calculate element center for snapping
        const elemCenterX = newX + element.width / 2;
        const elemCenterY = newY + element.height / 2;

        // Check for snap points against frames
        const { snapX, snapY, guides } = calculateSnapResult(elemCenterX, elemCenterY, frames);

        // Apply snapping - adjust position so element center aligns with snap point
        if (snapX !== null) {
          newX = snapX - element.width / 2;
        }
        if (snapY !== null) {
          newY = snapY - element.height / 2;
        }

        // Update snap guides visualization
        onSnapChange?.(guides);

        onChange({ x: newX, y: newY });
      } else if (dragState.type === 'resize' && dragState.handle) {
        const aspectRatio = dragState.startWidth / dragState.startHeight;
        let newX = dragState.startElemX;
        let newY = dragState.startElemY;
        let newW = dragState.startWidth;
        let newH = dragState.startHeight;

        // Corner handles - maintain aspect ratio
        if (dragState.handle === 'se') {
          // Use dominant axis
          if (Math.abs(dx) > Math.abs(dy)) {
            newW = Math.max(50, dragState.startWidth + dx);
            newH = newW / aspectRatio;
          } else {
            newH = Math.max(50, dragState.startHeight + dy);
            newW = newH * aspectRatio;
          }
        } else if (dragState.handle === 'sw') {
          if (Math.abs(dx) > Math.abs(dy)) {
            newW = Math.max(50, dragState.startWidth - dx);
            newH = newW / aspectRatio;
            newX = dragState.startElemX + (dragState.startWidth - newW);
          } else {
            newH = Math.max(50, dragState.startHeight + dy);
            newW = newH * aspectRatio;
            newX = dragState.startElemX + (dragState.startWidth - newW);
          }
        } else if (dragState.handle === 'ne') {
          if (Math.abs(dx) > Math.abs(dy)) {
            newW = Math.max(50, dragState.startWidth + dx);
            newH = newW / aspectRatio;
            newY = dragState.startElemY + (dragState.startHeight - newH);
          } else {
            newH = Math.max(50, dragState.startHeight - dy);
            newW = newH * aspectRatio;
            newY = dragState.startElemY + (dragState.startHeight - newH);
          }
        } else if (dragState.handle === 'nw') {
          if (Math.abs(dx) > Math.abs(dy)) {
            newW = Math.max(50, dragState.startWidth - dx);
            newH = newW / aspectRatio;
            newX = dragState.startElemX + (dragState.startWidth - newW);
            newY = dragState.startElemY + (dragState.startHeight - newH);
          } else {
            newH = Math.max(50, dragState.startHeight - dy);
            newW = newH * aspectRatio;
            newX = dragState.startElemX + (dragState.startWidth - newW);
            newY = dragState.startElemY + (dragState.startHeight - newH);
          }
        }
        // Edge handles - scale proportionally
        else if (dragState.handle === 'e') {
          newW = Math.max(50, dragState.startWidth + dx);
          newH = newW / aspectRatio;
          newY = dragState.startElemY + (dragState.startHeight - newH) / 2;
        } else if (dragState.handle === 'w') {
          newW = Math.max(50, dragState.startWidth - dx);
          newH = newW / aspectRatio;
          newX = dragState.startElemX + (dragState.startWidth - newW);
          newY = dragState.startElemY + (dragState.startHeight - newH) / 2;
        } else if (dragState.handle === 's') {
          newH = Math.max(50, dragState.startHeight + dy);
          newW = newH * aspectRatio;
          newX = dragState.startElemX + (dragState.startWidth - newW) / 2;
        } else if (dragState.handle === 'n') {
          newH = Math.max(50, dragState.startHeight - dy);
          newW = newH * aspectRatio;
          newX = dragState.startElemX + (dragState.startWidth - newW) / 2;
          newY = dragState.startElemY + (dragState.startHeight - newH);
        }

        onChange({ x: newX, y: newY, width: newW, height: newH });
      }
    };

    const handleMouseUp = () => {
      setDragState(null);
      // Clear snap guides when drag ends
      onSnapChange?.([]);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, scale, onChange, frames, element.width, element.height, onSnapChange]);

  // Only show loading placeholder if image is actually loading, not if processing
  // Processing shimmer is now rendered as a separate overlay layer
  // z-index 100 ensures shimmer shows ABOVE frame backgrounds (1) and borders (10)
  if (loading) {
    return (
      <div
        style={{ 
          position: 'absolute', 
          left: posX, 
          top: posY, 
          width, 
          height,
          zIndex: 100, // Above frames!
        }}
        className="rounded overflow-hidden bg-card/50"
      >
        {/* Shimmer loading effect - no text */}
        <div className="relative w-full h-full">
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.15) 50%, transparent 70%)',
              backgroundSize: '200% 100%',
              animation: 'shimmer 2s ease-in-out infinite',
            }}
          />
        </div>
        <style>{`
          @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
        `}</style>
      </div>
    );
  }

  if (error || !imageSrc) {
    return (
      <div style={{ position: 'absolute', left: posX, top: posY, width, height }} className="flex flex-col items-center justify-center bg-card/30 rounded border border-dashed border-border">
        <AlertCircle className="h-5 w-5 text-muted-foreground mb-1" />
        <span className="text-xs text-muted-foreground">Failed</span>
      </div>
    );
  }

  const isDragging = dragState?.type === 'move';
  const isResizing = dragState?.type === 'resize';

  return (
    <div
      onMouseDown={(e) => handleMouseDown(e, 'move')}
      style={{
        position: 'absolute',
        left: posX,
        top: posY,
        width,
        height,
        cursor: element.locked ? 'default' : isDragging ? 'grabbing' : 'grab',
        opacity: element.opacity || 1,
        transform: `rotate(${element.rotation || 0}deg)`,
        transformOrigin: 'center center',
        zIndex: 2,
        // NO clipPath here - selection UI must be fully visible
      }}
    >
      {/* Image content - THIS gets clipped if inside frame */}
      <div
        className="w-full h-full rounded overflow-hidden relative"
        style={{ clipPath: clipPath || undefined }}
      >
        <img src={imageSrc} alt={element.name} draggable={false} className="w-full h-full object-fill pointer-events-none" />
      </div>

      {/* Selection ring - OUTSIDE clipped area, always fully visible */}
      {isSelected && (
        <div
          className="absolute inset-0 rounded ring-2 ring-blue-500 pointer-events-none"
          style={{ zIndex: 5 }}
        />
      )}

      {/* Resize handles - OUTSIDE clipped area, always fully visible */}
      {isSelected && !element.locked && (
        <>
          {/* Corner handles - blue */}
          <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nwse-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'nw')} />
          <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nesw-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'ne')} />
          <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nesw-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'sw')} />
          <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nwse-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'se')} />
          {/* Edge handles - blue */}
          <div className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ew-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'w')} />
          <div className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ew-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'e')} />
          <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ns-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'n')} />
          <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ns-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 's')} />
        </>
      )}
    </div>
  );
}

// Frame element - a container/viewport that can be exported
function CanvasFrameElement({
  element,
  isSelected,
  onSelect,
  onChange,
  scale,
  stagePosition,
  allElements,
  onMoveChildren,
}: {
  element: FrameCanvasElement;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onChange: (newAttrs: Partial<FrameCanvasElement>) => void;
  scale: number;
  stagePosition: { x: number; y: number };
  allElements?: CanvasElement[];
  onMoveChildren?: (childStartPositions: { id: string; x: number; y: number }[], dx: number, dy: number) => void;
}) {
  const [dragState, setDragState] = useState<{
    type: 'move' | 'resize';
    handle?: string;
    startX: number;
    startY: number;
    startElemX: number;
    startElemY: number;
    startWidth: number;
    startHeight: number;
    childIds?: string[]; // IDs of elements inside this frame at drag start
    childStartPositions?: { id: string; x: number; y: number }[]; // Starting positions of children
  } | null>(null);

  const posX = element.x * scale + stagePosition.x;
  const posY = element.y * scale + stagePosition.y;
  const width = element.width * scale;
  const height = element.height * scale;

  const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'resize' = 'move', handle?: string) => {
    if (element.locked && type === 'move') return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(e);

    // Find all elements inside this frame at drag start (only for move, not resize)
    let childIds: string[] = [];
    let childStartPositions: { id: string; x: number; y: number }[] = [];
    if (type === 'move' && allElements) {
      const frameRight = element.x + element.width;
      const frameBottom = element.y + element.height;
      const children = allElements.filter(el => {
        if (el.id === element.id || el.type === 'frame') return false;
        // Check if element overlaps with frame
        const elRight = el.x + el.width;
        const elBottom = el.y + el.height;
        return el.x < frameRight && elRight > element.x && el.y < frameBottom && elBottom > element.y;
      });
      childIds = children.map(el => el.id);
      childStartPositions = children.map(el => ({ id: el.id, x: el.x, y: el.y }));
    }

    setDragState({
      type,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startElemX: element.x,
      startElemY: element.y,
      startWidth: element.width,
      startHeight: element.height,
      childIds,
      childStartPositions,
    });
  };

  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragState.startX) / scale;
      const dy = (e.clientY - dragState.startY) / scale;

      if (dragState.type === 'move') {
        onChange({ x: dragState.startElemX + dx, y: dragState.startElemY + dy });
        // Also move children
        if (onMoveChildren && dragState.childStartPositions && dragState.childStartPositions.length > 0) {
          onMoveChildren(dragState.childStartPositions, dx, dy);
        }
      } else if (dragState.type === 'resize' && dragState.handle) {
        let newX = dragState.startElemX;
        let newY = dragState.startElemY;
        let newW = dragState.startWidth;
        let newH = dragState.startHeight;

        // Frame resize - free aspect ratio (not locked like images)
        switch (dragState.handle) {
          case 'se':
            newW = Math.max(100, dragState.startWidth + dx);
            newH = Math.max(100, dragState.startHeight + dy);
            break;
          case 'sw':
            newW = Math.max(100, dragState.startWidth - dx);
            newH = Math.max(100, dragState.startHeight + dy);
            newX = dragState.startElemX + (dragState.startWidth - newW);
            break;
          case 'ne':
            newW = Math.max(100, dragState.startWidth + dx);
            newH = Math.max(100, dragState.startHeight - dy);
            newY = dragState.startElemY + (dragState.startHeight - newH);
            break;
          case 'nw':
            newW = Math.max(100, dragState.startWidth - dx);
            newH = Math.max(100, dragState.startHeight - dy);
            newX = dragState.startElemX + (dragState.startWidth - newW);
            newY = dragState.startElemY + (dragState.startHeight - newH);
            break;
          case 'e':
            newW = Math.max(100, dragState.startWidth + dx);
            break;
          case 'w':
            newW = Math.max(100, dragState.startWidth - dx);
            newX = dragState.startElemX + (dragState.startWidth - newW);
            break;
          case 's':
            newH = Math.max(100, dragState.startHeight + dy);
            break;
          case 'n':
            newH = Math.max(100, dragState.startHeight - dy);
            newY = dragState.startElemY + (dragState.startHeight - newH);
            break;
        }

        onChange({ x: newX, y: newY, width: newW, height: newH });
      }
    };

    const handleMouseUp = () => setDragState(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, scale, onChange]);

  const isDragging = dragState?.type === 'move';

  return (
    <div
      style={{
        position: 'absolute',
        left: posX,
        top: posY,
        width,
        height,
        opacity: element.opacity || 1,
        transform: `rotate(${element.rotation || 0}deg)`,
        transformOrigin: 'center center',
        zIndex: 10, // Frames always on top
        pointerEvents: 'none', // Frame area doesn't catch clicks - only label and handles do
      }}
    >
      {/* Frame border only - background rendered separately */}
      <div
        className="w-full h-full relative"
        style={{
          border: isSelected ? '2px solid #3b82f6' : '2px dashed #404040',
          borderRadius: '4px',
        }}
      >
        {/* Frame label - top left outside frame - THIS is the click target for selection/move */}
        <div
          className="absolute left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-t-sm"
          style={{
            top: '-22px',
            backgroundColor: isSelected ? '#3b82f6' : '#333333',
            color: '#fff',
            fontSize: '10px',
            cursor: element.locked ? 'default' : isDragging ? 'grabbing' : 'grab',
            pointerEvents: 'auto', // Label catches clicks
          }}
          onMouseDown={(e) => handleMouseDown(e, 'move')}
        >
          <Frame className="h-3 w-3" />
          <span className="truncate max-w-[100px]">{element.name}</span>
        </div>

        {/* Dimension indicator - bottom center when selected */}
        {isSelected && (
          <div
            className="absolute left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-sm pointer-events-none"
            style={{
              bottom: '-24px',
              backgroundColor: '#3b82f6',
              color: '#fff',
              fontSize: '11px',
              fontFamily: 'monospace',
              whiteSpace: 'nowrap',
            }}
          >
            {Math.round(element.width)} × {Math.round(element.height)}
          </div>
        )}
      </div>

      {/* Resize handles - blue when selected, pointer-events:auto so they're clickable */}
      {isSelected && !element.locked && (
        <>
          <div className="absolute -top-1.5 -left-1.5 w-3 h-3 rounded-sm cursor-nwse-resize z-10" style={{ pointerEvents: 'auto', backgroundColor: '#fff', border: '2px solid #3b82f6' }} onMouseDown={(e) => handleMouseDown(e, 'resize', 'nw')} />
          <div className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-sm cursor-nesw-resize z-10" style={{ pointerEvents: 'auto', backgroundColor: '#fff', border: '2px solid #3b82f6' }} onMouseDown={(e) => handleMouseDown(e, 'resize', 'ne')} />
          <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 rounded-sm cursor-nesw-resize z-10" style={{ pointerEvents: 'auto', backgroundColor: '#fff', border: '2px solid #3b82f6' }} onMouseDown={(e) => handleMouseDown(e, 'resize', 'sw')} />
          <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 rounded-sm cursor-nwse-resize z-10" style={{ pointerEvents: 'auto', backgroundColor: '#fff', border: '2px solid #3b82f6' }} onMouseDown={(e) => handleMouseDown(e, 'resize', 'se')} />
          <div className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 rounded-sm cursor-ew-resize z-10" style={{ pointerEvents: 'auto', backgroundColor: '#fff', border: '2px solid #3b82f6' }} onMouseDown={(e) => handleMouseDown(e, 'resize', 'w')} />
          <div className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 rounded-sm cursor-ew-resize z-10" style={{ pointerEvents: 'auto', backgroundColor: '#fff', border: '2px solid #3b82f6' }} onMouseDown={(e) => handleMouseDown(e, 'resize', 'e')} />
          <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-sm cursor-ns-resize z-10" style={{ pointerEvents: 'auto', backgroundColor: '#fff', border: '2px solid #3b82f6' }} onMouseDown={(e) => handleMouseDown(e, 'resize', 'n')} />
          <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-sm cursor-ns-resize z-10" style={{ pointerEvents: 'auto', backgroundColor: '#fff', border: '2px solid #3b82f6' }} onMouseDown={(e) => handleMouseDown(e, 'resize', 's')} />
        </>
      )}
    </div>
  );
}

// Crop Overlay Component - shows draggable crop rectangle
function CropOverlay({
  element,
  scale,
  stagePosition,
  cropRect,
  onCropChange,
}: {
  element: CanvasElement;
  scale: number;
  stagePosition: { x: number; y: number };
  cropRect: { x: number; y: number; width: number; height: number };
  onCropChange: (newRect: { x: number; y: number; width: number; height: number }) => void;
}) {
  const [dragState, setDragState] = useState<{
    type: 'move' | 'resize';
    handle?: string;
    startX: number;
    startY: number;
    startRect: { x: number; y: number; width: number; height: number };
  } | null>(null);

  // Calculate screen position and size
  const elemX = element.x * scale + stagePosition.x;
  const elemY = element.y * scale + stagePosition.y;
  const elemWidth = element.width * scale;
  const elemHeight = element.height * scale;

  // Crop rectangle in screen coordinates
  const cropX = elemX + cropRect.x * elemWidth;
  const cropY = elemY + cropRect.y * elemHeight;
  const cropWidth = cropRect.width * elemWidth;
  const cropHeight = cropRect.height * elemHeight;

  const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'resize', handle?: string) => {
    e.stopPropagation();
    e.preventDefault();
    setDragState({
      type,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startRect: { ...cropRect },
    });
  };

  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragState.startX) / elemWidth;
      const dy = (e.clientY - dragState.startY) / elemHeight;

      if (dragState.type === 'move') {
        // Move the crop rectangle
        let newX = dragState.startRect.x + dx;
        let newY = dragState.startRect.y + dy;

        // Constrain within bounds
        newX = Math.max(0, Math.min(1 - dragState.startRect.width, newX));
        newY = Math.max(0, Math.min(1 - dragState.startRect.height, newY));

        onCropChange({ ...dragState.startRect, x: newX, y: newY });
      } else if (dragState.type === 'resize' && dragState.handle) {
        let newX = dragState.startRect.x;
        let newY = dragState.startRect.y;
        let newW = dragState.startRect.width;
        let newH = dragState.startRect.height;

        const minSize = 0.1; // Minimum 10% of image size

        // Handle each resize direction
        switch (dragState.handle) {
          case 'nw':
            newX = Math.max(0, Math.min(dragState.startRect.x + dragState.startRect.width - minSize, dragState.startRect.x + dx));
            newY = Math.max(0, Math.min(dragState.startRect.y + dragState.startRect.height - minSize, dragState.startRect.y + dy));
            newW = dragState.startRect.width - (newX - dragState.startRect.x);
            newH = dragState.startRect.height - (newY - dragState.startRect.y);
            break;
          case 'ne':
            newY = Math.max(0, Math.min(dragState.startRect.y + dragState.startRect.height - minSize, dragState.startRect.y + dy));
            newW = Math.max(minSize, Math.min(1 - dragState.startRect.x, dragState.startRect.width + dx));
            newH = dragState.startRect.height - (newY - dragState.startRect.y);
            break;
          case 'sw':
            newX = Math.max(0, Math.min(dragState.startRect.x + dragState.startRect.width - minSize, dragState.startRect.x + dx));
            newW = dragState.startRect.width - (newX - dragState.startRect.x);
            newH = Math.max(minSize, Math.min(1 - dragState.startRect.y, dragState.startRect.height + dy));
            break;
          case 'se':
            newW = Math.max(minSize, Math.min(1 - dragState.startRect.x, dragState.startRect.width + dx));
            newH = Math.max(minSize, Math.min(1 - dragState.startRect.y, dragState.startRect.height + dy));
            break;
          case 'n':
            newY = Math.max(0, Math.min(dragState.startRect.y + dragState.startRect.height - minSize, dragState.startRect.y + dy));
            newH = dragState.startRect.height - (newY - dragState.startRect.y);
            break;
          case 's':
            newH = Math.max(minSize, Math.min(1 - dragState.startRect.y, dragState.startRect.height + dy));
            break;
          case 'w':
            newX = Math.max(0, Math.min(dragState.startRect.x + dragState.startRect.width - minSize, dragState.startRect.x + dx));
            newW = dragState.startRect.width - (newX - dragState.startRect.x);
            break;
          case 'e':
            newW = Math.max(minSize, Math.min(1 - dragState.startRect.x, dragState.startRect.width + dx));
            break;
        }

        onCropChange({ x: newX, y: newY, width: newW, height: newH });
      }
    };

    const handleMouseUp = () => setDragState(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, elemWidth, elemHeight, onCropChange]);

  return (
    <>
      {/* Dimmed overlay outside crop area */}
      <div
        className="absolute pointer-events-none z-30"
        style={{
          left: elemX,
          top: elemY,
          width: elemWidth,
          height: elemHeight,
        }}
      >
        <div className="absolute bg-black/50" style={{ left: 0, top: 0, width: '100%', height: cropRect.y * 100 + '%' }} />
        <div className="absolute bg-black/50" style={{ left: 0, bottom: 0, width: '100%', height: (1 - cropRect.y - cropRect.height) * 100 + '%' }} />
        <div className="absolute bg-black/50" style={{ left: 0, top: cropRect.y * 100 + '%', width: cropRect.x * 100 + '%', height: cropRect.height * 100 + '%' }} />
        <div className="absolute bg-black/50" style={{ right: 0, top: cropRect.y * 100 + '%', width: (1 - cropRect.x - cropRect.width) * 100 + '%', height: cropRect.height * 100 + '%' }} />
      </div>

      {/* Crop rectangle */}
      <div
        className="absolute border-2 border-blue-500 cursor-move z-40"
        style={{
          left: cropX,
          top: cropY,
          width: cropWidth,
          height: cropHeight,
        }}
        onMouseDown={(e) => handleMouseDown(e, 'move')}
      >
        {/* Corner handles */}
        <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nwse-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'nw')} />
        <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nesw-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'ne')} />
        <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nesw-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'sw')} />
        <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nwse-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'se')} />
        {/* Edge handles */}
        <div className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ew-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'w')} />
        <div className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ew-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'e')} />
        <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ns-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 'n')} />
        <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ns-resize z-10" onMouseDown={(e) => handleMouseDown(e, 'resize', 's')} />

        {/* Grid lines for rule of thirds */}
        <div className="absolute top-1/3 left-0 right-0 border-t border-blue-400/30" />
        <div className="absolute top-2/3 left-0 right-0 border-t border-blue-400/30" />
        <div className="absolute left-1/3 top-0 bottom-0 border-l border-blue-400/30" />
        <div className="absolute left-2/3 top-0 bottom-0 border-l border-blue-400/30" />
      </div>
    </>
  );
}

// Floating AI Toolbar Component
function FloatingToolbar({
  element,
  scale,
  stagePosition,
  onChange,
  onDuplicate,
  onDelete,
  onDownloadPng,
  onDownloadSvg,
  onImageUpdate,
  onProcessingChange,
  onOcrProcessing,
  onTextEditStateChange,
  onTextRegionSelect,
  externalSelectedRegion,
  onCropStateChange,
  externalCropRect,
  onCropCreate,
  authToken,
  sandboxId,
}: {
  element: ImageCanvasElement;
  scale: number;
  stagePosition: { x: number; y: number };
  onChange: (newAttrs: Partial<ImageCanvasElement>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDownloadPng: () => void;
  onDownloadSvg: () => void;
  onImageUpdate: (newSrc: string, newDimensions?: { width: number; height: number }) => void;
  onProcessingChange: (isProcessing: boolean, failed?: boolean) => void;
  onOcrProcessing: (isProcessing: boolean) => void; // OCR shimmer on SAME element (no duplicate)
  onTextEditStateChange: (state: { regions: TextRegion[]; ocrImageSize: { width: number; height: number } } | null) => void;
  onTextRegionSelect?: (region: TextRegion) => void;
  externalSelectedRegion?: TextRegion | null;
  onCropStateChange: (state: { cropRect: { x: number; y: number; width: number; height: number } } | null) => void;
  externalCropRect?: { x: number; y: number; width: number; height: number } | null;
  onCropCreate: (src: string, width: number, height: number) => void;
  authToken?: string;
  sandboxId?: string;
}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');

  // Text edit mode state
  const [textEditMode, setTextEditMode] = useState(false);
  const [isDetectingText, setIsDetectingText] = useState(false);
  const [detectedTextRegions, setDetectedTextRegions] = useState<TextRegion[]>([]);
  const [selectedTextRegion, setSelectedTextRegion] = useState<TextRegion | null>(null);
  const [newTextContent, setNewTextContent] = useState('');
  const [ocrImageSize, setOcrImageSize] = useState<{ width: number; height: number } | null>(null);
  const [showTextEditDialog, setShowTextEditDialog] = useState(false);
  const [isLowQualityOcr, setIsLowQualityOcr] = useState(false); // Skip bboxes, just prompt

  // Crop mode state
  const [cropMode, setCropMode] = useState(false);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number }>({
    x: 0.1, y: 0.1, width: 0.8, height: 0.8 // Normalized 0-1
  });
  const [isCropping, setIsCropping] = useState(false);

  // Sync with external selected region (from canvas-level clicks)
  useEffect(() => {
    if (externalSelectedRegion && externalSelectedRegion.id !== selectedTextRegion?.id) {
      setSelectedTextRegion(externalSelectedRegion);
      // Only pre-fill text if confidence is high enough (> 0.6), otherwise let user type
      const prefillText = externalSelectedRegion.confidence > 0.6 ? externalSelectedRegion.text : '';
      setNewTextContent(prefillText);
      setShowTextEditDialog(true);
    }
  }, [externalSelectedRegion]);

  // Reset text edit mode when element changes (user clicks different image)
  useEffect(() => {
    // Cancel any ongoing text edit mode when switching elements
    setTextEditMode(false);
    setIsDetectingText(false);
    setDetectedTextRegions([]);
    setSelectedTextRegion(null);
    setNewTextContent('');
    setShowTextEditDialog(false);
    setIsLowQualityOcr(false);
    onTextEditStateChange(null); // Clear canvas-level overlay

    // Also reset crop mode
    setCropMode(false);
    setCropRect({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  }, [element.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run OCR to detect text regions using backend Replicate model
  // NOTE: OCR does NOT create a duplicate - it just detects text for overlay
  const detectTextRegions = async () => {
    setIsDetectingText(true);
    onOcrProcessing(true); // Show shimmer on SAME image (no duplicate created)

    try {
      const imageBase64 = await getImageAsBase64(element.src);

      // Call backend OCR endpoint
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/canvas-ai/ocr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ image_base64: imageBase64 }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'OCR request failed');
      }

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'OCR failed');
      }

      // Store image size for overlay calculations
      const [ocrWidth, ocrHeight] = result.image_size || [1024, 1024];
      setOcrImageSize({ width: ocrWidth, height: ocrHeight });

      // Convert backend response to TextRegion format
      const regions: TextRegion[] = (result.text_lines || []).map((line: {
        id: string;
        text: string;
        confidence: number;
        bbox: [number, number, number, number];
        polygon: [number, number][];
      }) => ({
        id: line.id,
        text: line.text,
        confidence: line.confidence,
        bbox: line.bbox as [number, number, number, number],
        polygon: line.polygon as [number, number][],
      }));

      // Check OCR quality - if too poor, skip bounding boxes and just prompt
      const avgConfidence = regions.length > 0
        ? regions.reduce((sum, r) => sum + r.confidence, 0) / regions.length
        : 0;
      const lowConfidenceCount = regions.filter(r => r.confidence < 0.4).length;
      const isLowQuality = avgConfidence < 0.35 || (regions.length > 0 && lowConfidenceCount / regions.length > 0.7);

      if (regions.length === 0) {
        const fullText = (result.text || '').trim();
        if (fullText.length > 0) {
          // Text detected but no good bounding boxes - open generic prompt
          setIsLowQualityOcr(true);
          setSelectedTextRegion(null);
          setNewTextContent('');
          setShowTextEditDialog(true);
          toast.info('Opening text editor - describe the text you want to replace');
        } else {
          toast.warning('No text detected in this image');
          setTextEditMode(false);
        }
      } else if (isLowQuality) {
        // OCR quality too low - skip bounding boxes, just prompt
        setIsLowQualityOcr(true);
        setDetectedTextRegions([]); // Don't draw bboxes
        onTextEditStateChange(null); // Don't show overlay
        setSelectedTextRegion(null);
        setNewTextContent('');
        setShowTextEditDialog(true);
        toast.info('Low OCR quality - describe the text you want to replace');
      } else {
        // Good quality - show bounding boxes with polygons
        setIsLowQualityOcr(false);
        setDetectedTextRegions(regions);
        onTextEditStateChange({ regions, ocrImageSize: { width: ocrWidth, height: ocrHeight } });
        toast.success(`Found ${regions.length} text region${regions.length > 1 ? 's' : ''}`);
      }
    } catch (err) {
      console.error('OCR error:', err);
      toast.error('Failed to detect text: ' + (err instanceof Error ? err.message : 'Unknown error'));
      setTextEditMode(false);
    } finally {
      setIsDetectingText(false);
      onOcrProcessing(false); // Hide shimmer on same image
    }
  };

  // Start text edit mode
  const startTextEditMode = () => {
    setTextEditMode(true);
    setDetectedTextRegions([]);
    setSelectedTextRegion(null);
    detectTextRegions();
  };

  // Cancel text edit mode
  const cancelTextEditMode = () => {
    setTextEditMode(false);
    setDetectedTextRegions([]);
    setSelectedTextRegion(null);
    setNewTextContent('');
    setShowTextEditDialog(false);
    setIsLowQualityOcr(false);
    onTextEditStateChange(null); // Clear parent state
  };

  // Start crop mode
  const startCropMode = () => {
    setCropMode(true);
    const initialRect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    setCropRect(initialRect);
    onCropStateChange({ cropRect: initialRect });
  };

  // Cancel crop mode
  const cancelCropMode = () => {
    setCropMode(false);
    setCropRect({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    onCropStateChange(null);
  };

  // Update crop rectangle
  const handleCropChange = (newRect: { x: number; y: number; width: number; height: number }) => {
    setCropRect(newRect);
    onCropStateChange({ cropRect: newRect });
  };

  // Apply crop - crops the image client-side
  const applyCrop = async () => {
    const rect = externalCropRect || cropRect;
    if (!rect || isCropping) return;

    setIsCropping(true);

    try {
      const imageBase64 = await getImageAsBase64(element.src);

      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageBase64;
      });

      const cropX = Math.round(rect.x * img.width);
      const cropY = Math.round(rect.y * img.height);
      const cropW = Math.round(rect.width * img.width);
      const cropH = Math.round(rect.height * img.height);

      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');

      ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      const croppedBase64 = canvas.toDataURL('image/png');
      onCropCreate(croppedBase64, element.width * rect.width, element.height * rect.height);

      toast.success('Crop created!');
      cancelCropMode();
    } catch (err) {
      console.error('Crop error:', err);
      toast.error('Failed to crop: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsCropping(false);
    }
  };

  // Handle text region click
  const handleTextRegionClick = (region: TextRegion) => {
    setSelectedTextRegion(region);
    // Only pre-fill text if confidence is high (> 0.6), otherwise let user type
    setNewTextContent(region.confidence > 0.6 ? region.text : '');
    setShowTextEditDialog(true);
    onTextRegionSelect?.(region);
  };

  // Apply text replacement
  const applyTextReplacement = async () => {
    if (!newTextContent.trim()) return;

    setShowTextEditDialog(false);

    let prompt: string;

    if (isLowQualityOcr) {
      // Low quality OCR - user describes what to replace in the newTextContent field
      // The field contains a description like "change 'hello' to 'world'" or "replace the title with 'New Title'"
      prompt = `${newTextContent}. Keep the same font style, size, color, and position as the original text.`;
    } else if (selectedTextRegion) {
      // Good OCR with selected region
      if (selectedTextRegion.confidence > 0.6) {
        prompt = `Replace the text "${selectedTextRegion.text}" with "${newTextContent}" in this image. Keep the same font style, size, color, and position.`;
      } else {
        // Use bounding box description for low confidence
        // bbox format: [x1, y1, x2, y2]
        const [x0, y0, x1, y1] = selectedTextRegion.bbox;
        const centerX = ((x0 + x1) / 2 / (ocrImageSize?.width || 1)) * 100;
        const centerY = ((y0 + y1) / 2 / (ocrImageSize?.height || 1)) * 100;
        const position = centerY < 33 ? 'top' : centerY > 66 ? 'bottom' : 'middle';
        const hPosition = centerX < 33 ? 'left' : centerX > 66 ? 'right' : 'center';
        prompt = `Replace the text in the ${position}-${hPosition} area of this image with "${newTextContent}". Keep the same font style, size, color, and background.`;
      }
    } else {
      // Fallback
      prompt = `${newTextContent}. Keep the same font style, size, color, and position.`;
    }

    await handleAIAction('edit_text', prompt);
    cancelTextEditMode();
  };

  // Convert image URL/path to base64
  const getImageAsBase64 = async (src: string): Promise<string> => {
    // Already base64
    if (src.startsWith('data:')) {
      return src;
    }

    // Construct proper URL for sandbox files
    const url = sandboxId ? getSandboxFileUrl(sandboxId, src) : src;

    // Fetch the image and convert to base64
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const response = await fetch(url, {
        headers,
        credentials: 'include',
      });

      if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.error('Failed to convert image to base64:', err);
      throw new Error('Could not load image for processing');
    }
  };

  const handleAIAction = async (action: 'upscale' | 'remove_bg' | 'edit_text' | 'mark_edit', prompt?: string) => {
    setIsProcessing(true);
    setActiveAction(action);
    onProcessingChange(true);

    const actionLabels: Record<string, string> = {
      upscale: 'Upscaling image...',
      remove_bg: 'Removing background...',
      edit_text: 'Editing text...',
      mark_edit: 'Applying edit...',
    };

    toast.info(actionLabels[action], { description: prompt || 'Processing with AI...' });

    let succeeded = false;

    try {
      // Get actual base64 data (fetch if needed)
      const imageBase64 = await getImageAsBase64(element.src);

      // Call backend Canvas AI API
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/canvas-ai/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          action,
          image_base64: imageBase64,
          prompt: prompt || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'API request failed');
      }

      const result = await response.json();

      if (result.success && result.image_base64) {
        succeeded = true;
        // For upscale, get the new image dimensions
        if (action === 'upscale') {
          // Load the image to get its actual dimensions
          const img = new Image();
          img.onload = () => {
            onImageUpdate(result.image_base64, { width: img.naturalWidth, height: img.naturalHeight });
            toast.success(`Upscaled to ${img.naturalWidth}×${img.naturalHeight}!`);
          };
          img.onerror = () => {
            // Fallback: just update src without dimensions
            onImageUpdate(result.image_base64);
            toast.success('Upscale completed!');
          };
          img.src = result.image_base64;
        } else {
          // Other actions: just update the src
          onImageUpdate(result.image_base64);
          toast.success(`${action.replace('_', ' ')} completed!`);
        }
      } else {
        toast.error(result.error || 'Processing failed', {
          description: result.message || 'Please try again'
        });
      }

    } catch (err) {
      console.error('AI action error:', err);
      toast.error('Failed to process image', {
        description: err instanceof Error ? err.message : 'Unknown error'
      });
    } finally {
      setIsProcessing(false);
      setActiveAction(null);
      setEditPrompt('');
      // Pass failed=true if not succeeded (to remove placeholder)
      onProcessingChange(false, !succeeded);
    }
  };

  // When in text edit mode, show simplified toolbar
  if (textEditMode) {
    return (
      <div
        style={{
          position: 'absolute',
          left: element.x * scale + stagePosition.x + (element.width * scale) / 2,
          top: element.y * scale + stagePosition.y + element.height * scale + 8,
          transform: 'translateX(-50%)',
          zIndex: 100,
        }}
      >
        <div className="flex items-center gap-2 bg-card border border-border rounded-full px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Click on text to edit</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 rounded-full text-xs"
            onClick={cancelTextEditMode}
          >
            <X className="h-3 w-3 mr-1" />
            Cancel
          </Button>
        </div>

        {/* Text edit dialog - keep it here */}
        <Dialog open={showTextEditDialog} onOpenChange={setShowTextEditDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{isLowQualityOcr ? 'Edit Text' : 'Replace text'}</DialogTitle>
              <p className="text-sm text-muted-foreground">
                {isLowQualityOcr
                  ? "Describe what text to change and what to replace it with"
                  : selectedTextRegion && selectedTextRegion.confidence <= 60
                    ? "Type what text you want in this area"
                    : `Replacing: "${selectedTextRegion?.text || ''}"`
                }
              </p>
            </DialogHeader>
            <div className="space-y-4">
              <Textarea
                value={newTextContent}
                onChange={(e) => setNewTextContent(e.target.value)}
                placeholder={isLowQualityOcr
                  ? "e.g., Replace 'Hello' with 'Welcome' or Change the title to 'New Title'"
                  : selectedTextRegion && selectedTextRegion.confidence <= 60
                    ? "Type the new text you want here..."
                    : "Enter replacement text..."}
                className="min-h-[100px]"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={cancelTextEditMode}>
                  Cancel
                </Button>
                <Button onClick={applyTextReplacement} disabled={!newTextContent.trim() || isProcessing}>
                  {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  {isLowQualityOcr ? 'Apply' : 'Replace'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // When in crop mode, show crop toolbar
  if (cropMode) {
    return (
      <div
        style={{
          position: 'absolute',
          left: element.x * scale + stagePosition.x + (element.width * scale) / 2,
          top: element.y * scale + stagePosition.y + element.height * scale + 8,
          transform: 'translateX(-50%)',
          zIndex: 100,
        }}
      >
        <div className="flex items-center gap-2 bg-card border border-border rounded-full px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Select area</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 rounded-full text-xs"
            onClick={cancelCropMode}
            disabled={isCropping}
          >
            <X className="h-3 w-3 mr-1" />
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 px-3 rounded-full text-xs"
            onClick={applyCrop}
            disabled={isCropping}
          >
            {isCropping ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Create
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: element.x * scale + stagePosition.x + (element.width * scale) / 2,
        top: element.y * scale + stagePosition.y + element.height * scale + 8,
        transform: 'translateX(-50%)',
        zIndex: 100,
      }}
    >
      {/* File info - inline centered */}
      <div className="flex items-center justify-center gap-2 mb-1">
        <span className="text-xs text-muted-foreground truncate max-w-[150px]">{element.name}</span>
        <span className="text-xs text-muted-foreground">{Math.round(element.width)}×{Math.round(element.height)}</span>
      </div>

      {/* Main AI toolbar */}
      <div className="flex items-center gap-0.5 bg-card border border-border rounded-full px-1.5 py-1">
        <TooltipProvider delayDuration={0}>
          {/* Upscale */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                onClick={() => handleAIAction('upscale')}
                disabled={isProcessing}
              >
                {activeAction === 'upscale' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span className="text-[10px] font-bold border border-current rounded px-0.5">HD</span>
                )}
                Upscale
              </Button>
            </TooltipTrigger>
            <TooltipContent>Upscale image with AI</TooltipContent>
          </Tooltip>

          {/* Remove Background */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                onClick={() => handleAIAction('remove_bg')}
                disabled={isProcessing}
              >
                {activeAction === 'remove_bg' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="1" y="1" width="6" height="6" />
                    <rect x="9" y="1" width="6" height="6" strokeDasharray="2 1" />
                    <rect x="1" y="9" width="6" height="6" strokeDasharray="2 1" />
                    <rect x="9" y="9" width="6" height="6" />
                  </svg>
                )}
                Remove bg
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove background with AI</TooltipContent>
          </Tooltip>

          {/* Edit Text - OCR-based selection */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                onClick={startTextEditMode}
                disabled={isProcessing || textEditMode}
              >
                {isDetectingText ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Type className="h-3.5 w-3.5" />}
                Edit text
              </Button>
            </TooltipTrigger>
            <TooltipContent>Select and edit text in image</TooltipContent>
          </Tooltip>

          {/* Crop Copy */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                onClick={startCropMode}
                disabled={isProcessing || cropMode}
              >
                <Scissors className="h-3.5 w-3.5" />
                Cut
              </Button>
            </TooltipTrigger>
            <TooltipContent>Create cropped copy</TooltipContent>
          </Tooltip>

          {/* Mark Edit - with prompt input */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 rounded-full gap-1.5 text-xs"
                    disabled={isProcessing}
                  >
                    {activeAction === 'mark_edit' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="2" y="2" width="12" height="12" strokeDasharray="3 2" rx="1" />
                        <path d="M6 8L7.5 9.5L10 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    Edit
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>AI-powered image editing</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-80 p-3" align="end">
              <div className="space-y-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">AI Image Edit</div>
                <Textarea
                  placeholder="Describe the edit you want to make..."
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  className="min-h-[80px] resize-none shadow-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.metaKey && editPrompt.trim()) {
                      handleAIAction('mark_edit', editPrompt);
                    }
                  }}
                />
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => handleAIAction('mark_edit', editPrompt)}
                  disabled={!editPrompt.trim() || isProcessing}
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Generating...
                    </>
                  ) : (
                    'Generate'
                  )}
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Download - dropdown menu */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full">
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="center" className="min-w-[140px]">
              <DropdownMenuItem onClick={onDownloadPng} className="cursor-pointer">
                <span className="font-medium">PNG</span>
                <span className="ml-auto text-xs text-muted-foreground">Default</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDownloadSvg} className="cursor-pointer">
                <span className="font-medium">SVG</span>
                <span className="ml-auto text-xs text-muted-foreground">Vector</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Copy - icon only */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={onDuplicate}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Duplicate</TooltipContent>
          </Tooltip>

          {/* Delete - icon only */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-destructive hover:text-destructive" onClick={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

// Floating toolbar for Frame elements - simpler than image toolbar
function FrameFloatingToolbar({
  element,
  elements,
  scale,
  stagePosition,
  onChange,
  onDuplicate,
  onDelete,
  onExportFrame,
  sandboxId,
  authToken,
}: {
  element: FrameCanvasElement;
  elements: CanvasElement[]; // All elements for export
  scale: number;
  stagePosition: { x: number; y: number };
  onChange: (newAttrs: Partial<FrameCanvasElement>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExportFrame: () => void;
  sandboxId?: string;
  authToken?: string;
}) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showSizePopover, setShowSizePopover] = useState(false);
  const [showNamePopover, setShowNamePopover] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [tempWidth, setTempWidth] = useState(String(Math.round(element.width)));
  const [tempHeight, setTempHeight] = useState(String(Math.round(element.height)));
  const [tempName, setTempName] = useState(element.name);

  // Sync temp values when element changes
  useEffect(() => {
    setTempWidth(String(Math.round(element.width)));
    setTempHeight(String(Math.round(element.height)));
    setTempName(element.name);
  }, [element.width, element.height, element.name]);

  // Common preset colors
  const presetColors = [
    'transparent', '#ffffff', '#000000', '#f5f5f5', '#1a1a1a',
    '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6',
  ];

  // Apply size changes
  const applySize = () => {
    const newWidth = Math.max(100, parseInt(tempWidth) || 400);
    const newHeight = Math.max(100, parseInt(tempHeight) || 300);
    onChange({ width: newWidth, height: newHeight });
    setShowSizePopover(false);
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: element.x * scale + stagePosition.x + (element.width * scale) / 2,
        top: element.y * scale + stagePosition.y + element.height * scale + 8,
        transform: 'translateX(-50%)',
        zIndex: 100,
      }}
    >
      {/* Frame toolbar */}
      <div className="flex items-center gap-0.5 bg-card border border-border rounded-full px-1.5 py-1">
        <TooltipProvider delayDuration={0}>
          {/* Frame name - clickable to edit */}
          <Popover open={showNamePopover} onOpenChange={setShowNamePopover}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 rounded-full gap-1 text-xs"
                  >
                    <Frame className="h-3 w-3" />
                    <span className="truncate max-w-[80px]">{element.name}</span>
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Rename frame</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-auto p-3" align="center">
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground font-medium">Frame Name</div>
                <input
                  type="text"
                  value={tempName}
                  onChange={(e) => setTempName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onChange({ name: tempName.trim() || 'Frame' });
                      setShowNamePopover(false);
                    }
                  }}
                  className="w-40 h-7 px-2 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                  autoFocus
                />
                <Button
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={() => {
                    onChange({ name: tempName.trim() || 'Frame' });
                    setShowNamePopover(false);
                  }}
                >
                  Rename
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Size control */}
          <Popover open={showSizePopover} onOpenChange={setShowSizePopover}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 rounded-full gap-1 text-xs font-mono"
                  >
                    {Math.round(element.width)}×{Math.round(element.height)}
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Set dimensions</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-auto p-3" align="center">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground font-medium">Frame Size</div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground">
                        Presets
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-48 p-1 max-h-64 overflow-y-auto" align="end" side="right">
                      {[
                        {
                          cat: 'SOCIAL', items: [
                            { n: 'Instagram Post', w: 1080, h: 1080 },
                            { n: 'Instagram Story', w: 1080, h: 1920 },
                            { n: 'TikTok', w: 1080, h: 1920 },
                            { n: 'Twitter Post', w: 1200, h: 675 },
                            { n: 'Facebook Post', w: 1200, h: 630 },
                            { n: 'YouTube Thumb', w: 1280, h: 720 },
                          ]
                        },
                        {
                          cat: 'DEVICES', items: [
                            { n: 'iPhone 15 Pro', w: 1179, h: 2556 },
                            { n: 'iPhone 15 Pro Max', w: 1290, h: 2796 },
                            { n: 'iPad Pro 11"', w: 1668, h: 2388 },
                          ]
                        },
                        {
                          cat: 'DESIGN', items: [
                            { n: 'Dribbble', w: 400, h: 300 },
                            { n: 'Dribbble HD', w: 800, h: 600 },
                            { n: 'Square', w: 1000, h: 1000 },
                          ]
                        },
                      ].map(cat => (
                        <div key={cat.cat}>
                          <div className="px-2 py-1 text-[9px] text-muted-foreground uppercase tracking-wider">{cat.cat}</div>
                          {cat.items.map(p => (
                            <button
                              key={p.n}
                              className="w-full flex items-center justify-between px-2 py-1 text-xs hover:bg-accent rounded-lg text-left"
                              onClick={() => {
                                setTempWidth(String(p.w));
                                setTempHeight(String(p.h));
                              }}
                            >
                              <span>{p.n}</span>
                              <span className="text-[9px] text-muted-foreground font-mono">{p.w}×{p.h}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground uppercase">Width</label>
                    <input
                      type="number"
                      value={tempWidth}
                      onChange={(e) => setTempWidth(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && applySize()}
                      className="w-20 h-7 px-2 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                      min={100}
                    />
                  </div>
                  <X className="h-3 w-3 text-muted-foreground mt-4" />
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground uppercase">Height</label>
                    <input
                      type="number"
                      value={tempHeight}
                      onChange={(e) => setTempHeight(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && applySize()}
                      className="w-20 h-7 px-2 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                      min={100}
                    />
                  </div>
                </div>
                <Button size="sm" className="w-full h-7 text-xs" onClick={applySize}>
                  Apply
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Background color */}
          <Popover open={showColorPicker} onOpenChange={setShowColorPicker}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 rounded-full gap-1.5 text-xs"
                  >
                    <div
                      className="w-3.5 h-3.5 rounded-sm border border-border"
                      style={{
                        backgroundColor: element.backgroundColor || 'transparent',
                        backgroundImage: !element.backgroundColor || element.backgroundColor === 'transparent'
                          ? 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)'
                          : undefined,
                        backgroundSize: '6px 6px',
                        backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0px',
                      }}
                    />
                    Fill
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Background color</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-auto p-2" align="center">
              <div className="grid grid-cols-6 gap-1">
                {presetColors.map((color) => (
                  <button
                    key={color}
                    className={cn(
                      "w-6 h-6 rounded-sm border border-border hover:ring-2 hover:ring-blue-500 transition-all",
                      element.backgroundColor === color && "ring-2 ring-blue-500"
                    )}
                    style={{
                      backgroundColor: color === 'transparent' ? 'transparent' : color,
                      backgroundImage: color === 'transparent'
                        ? 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)'
                        : undefined,
                      backgroundSize: '8px 8px',
                      backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
                    }}
                    onClick={() => {
                      onChange({ backgroundColor: color === 'transparent' ? undefined : color });
                      setShowColorPicker(false);
                    }}
                  />
                ))}
                {/* Custom color picker */}
                <label
                  className="w-6 h-6 rounded-sm border border-dashed border-muted-foreground hover:border-blue-500 hover:ring-2 hover:ring-blue-500 transition-all cursor-pointer flex items-center justify-center overflow-hidden relative bg-background"
                >
                  <Plus className="h-3 w-3 text-muted-foreground" />
                  <input
                    type="color"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    value={element.backgroundColor || '#ffffff'}
                    onChange={(e) => {
                      onChange({ backgroundColor: e.target.value });
                    }}
                  />
                </label>
              </div>
            </PopoverContent>
          </Popover>

          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Export as PNG */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                onClick={onExportFrame}
                disabled={isExporting}
              >
                {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Export
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export frame as PNG</TooltipContent>
          </Tooltip>

          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Duplicate */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={onDuplicate}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Duplicate</TooltipContent>
          </Tooltip>

          {/* Delete */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-destructive hover:text-destructive" onClick={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

// Multi-select toolbar for merging multiple images
function MultiSelectToolbar({
  elements,
  scale,
  stagePosition,
  onStartMerge,
  onMergeComplete,
  onMergeFailed,
  onDelete,
  onProcessingChange,
  authToken,
  sandboxId,
}: {
  elements: CanvasElement[];
  scale: number;
  stagePosition: { x: number; y: number };
  onStartMerge: () => string; // Returns temp element ID
  onMergeComplete: (tempId: string, mergedImageSrc: string) => void;
  onMergeFailed: (tempId: string) => void;
  onDelete: () => void;
  onProcessingChange: (isProcessing: boolean) => void;
  authToken?: string;
  sandboxId?: string;
}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [mergePrompt, setMergePrompt] = useState('');
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [imageOrder, setImageOrder] = useState<string[]>([]); // IDs in order

  // Initialize image order when dialog opens
  const openMergeDialog = () => {
    setImageOrder(elements.map(el => el.id));
    setShowMergeDialog(true);
  };

  // Get ordered elements based on current order (only image elements for merging)
  const orderedElements = imageOrder
    .map(id => elements.find(el => el.id === id))
    .filter((el): el is ImageCanvasElement => el !== undefined && el.type === 'image');

  // Swap two images in the order
  const swapImages = (idx1: number, idx2: number) => {
    setImageOrder(prev => {
      const newOrder = [...prev];
      [newOrder[idx1], newOrder[idx2]] = [newOrder[idx2], newOrder[idx1]];
      return newOrder;
    });
  };

  // Calculate center position of all selected elements
  const bounds = elements.reduce((acc, el) => ({
    minX: Math.min(acc.minX, el.x),
    minY: Math.min(acc.minY, el.y),
    maxX: Math.max(acc.maxX, el.x + el.width),
    maxY: Math.max(acc.maxY, el.y + el.height),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

  const centerX = ((bounds.minX + bounds.maxX) / 2) * scale + stagePosition.x;
  const bottomY = bounds.maxY * scale + stagePosition.y + 8;

  // Convert image to base64
  const getImageAsBase64 = async (src: string): Promise<string> => {
    if (src.startsWith('data:')) return src;

    const url = sandboxId ? getSandboxFileUrl(sandboxId, src) : src;
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const response = await fetch(url, { headers, credentials: 'include' });
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const handleMerge = async () => {
    if (!mergePrompt.trim() || elements.length < 2) return;

    setIsProcessing(true);
    onProcessingChange(true);

    // Create temporary placeholder element with shimmer
    const tempId = onStartMerge();

    toast.info('Merging images...', { description: mergePrompt });

    try {
      // Get all images as base64 in the user-specified order
      const imagesBase64 = await Promise.all(
        orderedElements.map(async (el) => ({
          id: el.id,
          base64: await getImageAsBase64(el.src),
          width: el.width,
          height: el.height,
        }))
      );

      // Send to backend - use correct backend URL
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
      const response = await fetch(`${backendUrl}/canvas-ai/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          images: imagesBase64.map(img => img.base64),
          prompt: mergePrompt,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to merge images');
      }

      const result = await response.json();

      if (result.image) {
        toast.success('Images merged successfully!');
        onMergeComplete(tempId, result.image);
      } else {
        throw new Error('No image returned from merge');
      }
    } catch (err) {
      console.error('Merge error:', err);
      toast.error('Failed to merge images', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
      onMergeFailed(tempId);
    } finally {
      setIsProcessing(false);
      setMergePrompt('');
      onProcessingChange(false);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: centerX,
        top: bottomY,
        transform: 'translateX(-50%)',
        zIndex: 100,
      }}
    >
      {/* Selection info */}
      <div className="flex items-center justify-center gap-2 mb-1">
        <span className="text-xs text-muted-foreground">{elements.length} images selected</span>
      </div>

      {/* Merge toolbar */}
      <div className="flex items-center gap-1 bg-card border border-border rounded-full px-2 py-1">
        <TooltipProvider delayDuration={0}>
          {/* Merge button - opens dialog */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 rounded-full gap-1.5 text-xs"
                disabled={isProcessing}
                onClick={openMergeDialog}
              >
                {isProcessing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
                Merge
              </Button>
            </TooltipTrigger>
            <TooltipContent>Merge selected images with AI</TooltipContent>
          </Tooltip>

          {/* Separator */}
          <div className="w-px h-4 bg-border mx-1" />

          {/* Delete all */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-full text-destructive hover:text-destructive"
                onClick={onDelete}
                disabled={isProcessing}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete selected</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Merge Dialog */}
      <Dialog open={showMergeDialog} onOpenChange={setShowMergeDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Merge images</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Image order preview */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Image order (click arrows to swap)</label>
              <div className="flex items-center gap-2 overflow-x-auto py-2">
                {orderedElements.map((el, idx) => (
                  <div key={el.id} className="flex items-center gap-1">
                    <div className="relative group">
                      <div className="w-16 h-16 rounded border border-border overflow-hidden bg-card shrink-0 relative">
                        {el.src?.startsWith('data:') ? (
                          <img
                            src={el.src}
                            alt={el.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center text-xs text-muted-foreground p-1">
                            <ImagePlus className="h-4 w-4 mb-0.5 opacity-50" />
                            <span className="truncate w-full text-center text-[9px]">{el.name?.split('/').pop() || `Image ${idx + 1}`}</span>
                          </div>
                        )}
                      </div>
                      <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-[10px] px-1.5 rounded-full">
                        {idx + 1}
                      </div>
                    </div>
                    {idx < orderedElements.length - 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => swapImages(idx, idx + 1)}
                        title="Swap with next"
                      >
                        <ArrowLeftRight className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Merge prompt */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">How should these images be merged?</label>
              <Textarea
                value={mergePrompt}
                onChange={(e) => setMergePrompt(e.target.value)}
                placeholder='e.g. "Blend seamlessly", "Create a collage", "Overlay second on first"'
                className="min-h-[80px]"
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowMergeDialog(false); setMergePrompt(''); }}>
                Cancel
              </Button>
              <Button
                onClick={() => { setShowMergeDialog(false); handleMerge(); }}
                disabled={!mergePrompt.trim() || isProcessing}
              >
                {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function CanvasRenderer({ content, filePath, fileName, sandboxId, className, onSave }: CanvasRendererProps) {
  const { session } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [processingElementId, setProcessingElementId] = useState<string | null>(null);
  const [pendingPlaceholderId, setPendingPlaceholderId] = useState<string | null>(null);
  const pendingPlaceholderIdRef = useRef<string | null>(null);

  // Text edit mode state - managed at canvas level for proper positioning
  const [textEditState, setTextEditState] = useState<{
    elementId: string;
    regions: TextRegion[];
    ocrImageSize: { width: number; height: number };
  } | null>(null);
  const [selectedTextRegion, setSelectedTextRegion] = useState<TextRegion | null>(null);

  // Crop mode state - managed at canvas level for overlay rendering
  const [cropState, setCropState] = useState<{
    elementId: string;
    cropRect: { x: number; y: number; width: number; height: number };
  } | null>(null);

  // Snap guides state - for visual alignment feedback when dragging
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);

  const [canvasData, setCanvasData] = useState<CanvasData | null>(null);
  const [scale, setScale] = useState(1);
  const [stagePosition, setStagePosition] = useState({ x: 50, y: 50 });
  const [toolMode, setToolMode] = useState<'select' | 'pan'>('select');
  const [isPanning, setIsPanning] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [selectionRect, setSelectionRect] = useState<{ startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // AI Generate state
  const [generatePrompt, setGeneratePrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedPreviews, setGeneratedPreviews] = useState<string[]>([]);

  const panStartRef = useRef<{ x: number; y: number; stageX: number; stageY: number } | null>(null);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const hasCenteredRef = useRef(false);
  const isSavingRef = useRef(false);

  const authToken = session?.access_token;

  // Memoized frames for snapping - available to child components
  const frames = useMemo(() =>
    elements.filter(el => el.type === 'frame') as FrameCanvasElement[],
    [elements]
  );

  // Keep ref in sync with state
  useEffect(() => { isSavingRef.current = isSaving; }, [isSaving]);

  // Parse content - handle empty, invalid, and valid JSON
  useEffect(() => {
    if (!content) {
      // No content yet - create empty canvas structure
      const emptyCanvas: CanvasData = {
        name: fileName.replace('.kanvax', ''),
        version: '1.0',
        background: 'var(--background)',
        description: '',
        elements: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setCanvasData(emptyCanvas);
      setElements([]);
      return;
    }

    try {
      const parsed: CanvasData = JSON.parse(content);
      // Compare with current data to see if this is actually a new update
      const newElementCount = (parsed.elements || []).length;
      const currentElementCount = elements.length;

      // Only update if structure changed (avoids unnecessary re-renders during user editing)
      if (!canvasData ||
        JSON.stringify(parsed.elements?.map(e => e.id)) !== JSON.stringify(elements.map(e => e.id)) ||
        parsed.background !== canvasData.background) {
        setCanvasData(parsed);
        setElements(sanitizeElements(parsed.elements || []));
        // Only reset centering if this is first load or elements were added
        if (!hasCenteredRef.current || (newElementCount > currentElementCount)) {
          hasCenteredRef.current = false;
        }
      }
    } catch (e) {
      console.error('[CanvasRenderer] Parse error:', e, 'Content:', content?.substring(0, 100));
      // If parsing fails and we don't have canvas data, create empty structure
      if (!canvasData) {
        const emptyCanvas: CanvasData = {
          name: fileName.replace('.kanvax', ''),
          version: '1.0',
          background: 'var(--background)',
          description: '',
          elements: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setCanvasData(emptyCanvas);
        setElements([]);
      }
    }
  }, [content, fileName]);

  useEffect(() => { setIsMounted(true); }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({ width: containerRef.current.offsetWidth, height: containerRef.current.offsetHeight });
      }
    };
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    updateSize();
    return () => observer.disconnect();
  }, []);

  // Live updates: Poll for canvas file changes when not actively editing
  // This allows AI updates to appear in real-time
  const lastFetchTimeRef = useRef<number>(0);
  const isUserEditingRef = useRef(false);
  const elementsRef = useRef(elements);

  // Keep elementsRef in sync
  useEffect(() => {
    elementsRef.current = elements;
  }, [elements]);

  // Force fetch function that can be triggered externally
  const forceFetch = useCallback(async () => {
    const hasUnsaved = hasUnsavedChangesRef.current;
    const isEditing = isUserEditingRef.current;
    
    console.log('[CANVAS_LIVE_DEBUG] forceFetch called:', { 
      sandboxId, 
      filePath, 
      hasAuth: !!authToken, 
      hasUnsaved,
      isEditing,
    });

    if (!sandboxId || !filePath || !authToken) {
      console.log('[CANVAS_LIVE_DEBUG] forceFetch skipped - missing required params');
      return;
    }
    if (hasUnsaved || isEditing) {
      console.log('[CANVAS_LIVE_DEBUG] forceFetch skipped - user editing or unsaved changes');
      return;
    }

    lastFetchTimeRef.current = Date.now();

    try {
      const baseUrl = getSandboxFileUrl(sandboxId, filePath);
      const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`;
      console.log('[CANVAS_LIVE_DEBUG] forceFetch fetching:', url);

      const response = await fetch(url, {
        headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
        credentials: 'include',
        cache: 'no-store',
      });

      console.log('[CANVAS_LIVE_DEBUG] forceFetch response status:', response.status);

      if (!response.ok) {
        console.log('[CANVAS_LIVE_DEBUG] forceFetch failed - bad response');
        return;
      }

      const newContent = await response.text();
      console.log('[CANVAS_LIVE_DEBUG] forceFetch content length:', newContent?.length);

      if (!newContent) return;

      try {
        const parsed: CanvasData = JSON.parse(newContent);
        const serverCount = parsed.elements?.length || 0;
        const localCount = elementsRef.current.length;
        const newElementIds = (parsed.elements || []).map(e => e.id).sort().join(',');
        const currentElementIds = elementsRef.current.map(e => e.id).sort().join(',');

        console.log('[CANVAS_LIVE_DEBUG] forceFetch comparing elements:', {
          serverCount,
          localCount,
          changed: newElementIds !== currentElementIds,
          hasUnsavedNow: hasUnsavedChangesRef.current,
        });

        // Don't overwrite local state if we have more elements locally (user added something)
        if (localCount > serverCount) {
          console.log('[CANVAS_LIVE_DEBUG] forceFetch SKIPPED - local has MORE elements (user added content)');
          return;
        }

        if (newElementIds !== currentElementIds) {
          console.log('[CANVAS_LIVE_DEBUG] forceFetch updating elements - CHANGE DETECTED!');
          // Only re-center if server has MORE elements (AI added content)
          const shouldRecenter = serverCount > localCount;
          setCanvasData(parsed);
          setElements(sanitizeElements(parsed.elements || []));
          if (shouldRecenter) {
            hasCenteredRef.current = false; // Re-center to show new AI-added content
          }
        } else {
          console.log('[CANVAS_LIVE_DEBUG] forceFetch - no changes detected');
        }
      } catch (parseErr) {
        console.log('[CANVAS_LIVE_DEBUG] forceFetch parse error:', parseErr);
      }
    } catch (err) {
      console.log('[CANVAS_LIVE_DEBUG] forceFetch network error:', err);
    }
  }, [sandboxId, filePath, authToken]);

  // Listen for canvas-tool-updated events to trigger immediate refresh
  useEffect(() => {
    console.log('[CANVAS_LIVE_DEBUG] Setting up canvas-tool-updated listener for filePath:', filePath);

    const handleCanvasUpdate = (event: CustomEvent<{ canvasPath: string; timestamp: number }>) => {
      const eventPath = event.detail.canvasPath;
      console.log('[CANVAS_LIVE_DEBUG] Received canvas-tool-updated event:', {
        eventPath,
        filePath,
        timestamp: event.detail.timestamp,
      });

      // Check if this event is for our canvas
      if (filePath && (filePath.includes(eventPath) || eventPath.includes(filePath.replace('canvases/', '')))) {
        console.log('[CANVAS_LIVE_DEBUG] Event matches our canvas, calling forceFetch');
        forceFetch();
      } else {
        console.log('[CANVAS_LIVE_DEBUG] Event does NOT match our canvas, ignoring');
      }
    };

    window.addEventListener('canvas-tool-updated', handleCanvasUpdate as EventListener);

    // Check for any pending events that were dispatched before listener was set up
    const pendingEvents = (window as any).__pendingCanvasRefreshEvents as Map<string, number> | undefined;
    if (pendingEvents && filePath) {
      // Check if any pending event matches our canvas
      for (const [eventPath, timestamp] of pendingEvents.entries()) {
        // Only process events from the last 10 seconds
        if (Date.now() - timestamp < 10000) {
          if (filePath.includes(eventPath) || eventPath.includes(filePath.replace('canvases/', '').replace('/workspace/', ''))) {
            console.log('[CANVAS_LIVE_DEBUG] Found pending event for our canvas, forcing fetch:', eventPath);
            pendingEvents.delete(eventPath); // Clear after processing
            forceFetch();
            break;
          }
        } else {
          // Clean up old events
          pendingEvents.delete(eventPath);
        }
      }
    }

    return () => {
      console.log('[CANVAS_LIVE_DEBUG] Removing canvas-tool-updated listener');
      window.removeEventListener('canvas-tool-updated', handleCanvasUpdate as EventListener);
    };
  }, [filePath, forceFetch]);

  useEffect(() => {
    if (!sandboxId || !filePath || !authToken) return;

    // Poll interval: 1.5 seconds for faster AI updates, skip when user is editing
    const POLL_INTERVAL = 1500;

    const fetchLatestContent = async () => {
      // Skip if user is actively editing (has unsaved changes)
      const hasUnsaved = hasUnsavedChangesRef.current;
      const isEditing = isUserEditingRef.current;
      
      if (hasUnsaved || isEditing) {
        console.log('[CANVAS_LIVE_DEBUG] Polling skipped - user editing or unsaved changes', { hasUnsaved, isEditing });
        return;
      }

      // Skip if we just fetched (with small buffer)
      const now = Date.now();
      if (now - lastFetchTimeRef.current < POLL_INTERVAL - 200) return;
      lastFetchTimeRef.current = now;

      console.log('[CANVAS_LIVE_DEBUG] Polling: fetching canvas content');

      try {
        // Add cache-busting to ensure fresh content from server
        const baseUrl = getSandboxFileUrl(sandboxId, filePath);
        const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`;
        const response = await fetch(url, {
          headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
          credentials: 'include',
          cache: 'no-store', // Prevent browser caching
        });

        if (!response.ok) {
          console.log('[CANVAS_LIVE_DEBUG] Polling: fetch failed with status', response.status);
          return;
        }

        const newContent = await response.text();
        if (!newContent) return;

        // Parse and update if different - always parse to compare element IDs
        try {
          const parsed: CanvasData = JSON.parse(newContent);
          const serverCount = parsed.elements?.length || 0;
          const localCount = elementsRef.current.length;
          const newElementIds = (parsed.elements || []).map(e => e.id).sort().join(',');
          const currentElementIds = elementsRef.current.map(e => e.id).sort().join(',');

          console.log('[CANVAS_LIVE_DEBUG] Polling: comparing elements', {
            serverCount,
            localCount,
            changed: newElementIds !== currentElementIds,
            hasUnsavedNow: hasUnsavedChangesRef.current,
          });

          // Don't overwrite local state if we have more elements locally (user added something)
          if (localCount > serverCount) {
            console.log('[CANVAS_LIVE_DEBUG] Polling SKIPPED - local has MORE elements (user added content)');
            return;
          }

          // Only update if structure actually changed (new/removed elements)
          if (newElementIds !== currentElementIds) {
            console.log('[CANVAS_LIVE_DEBUG] Polling: UPDATING - new elements detected!');
            // Only re-center if server has MORE elements (AI added content)
            const shouldRecenter = serverCount > localCount;
            setCanvasData(parsed);
            setElements(sanitizeElements(parsed.elements || []));
            if (shouldRecenter) {
              hasCenteredRef.current = false; // Re-center to show new AI-added content
            }
          }
        } catch (parseErr) {
          console.log('[CANVAS_LIVE_DEBUG] Polling: parse error', parseErr);
        }
      } catch (err) {
        console.log('[CANVAS_LIVE_DEBUG] Polling: network error', err);
      }
    };

    const interval = setInterval(fetchLatestContent, POLL_INTERVAL);

    return () => clearInterval(interval);
    // Note: elements and hasUnsavedChanges are accessed via ref pattern to avoid re-creating interval
  }, [sandboxId, filePath, authToken]);

  // Center canvas and fit content on initial load only
  useEffect(() => {
    if (hasCenteredRef.current) return; // Already centered, don't run again
    if (elements.length === 0 || containerSize.width === 0 || containerSize.height === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    elements.forEach(el => {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    });

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const contentCenterX = minX + contentWidth / 2;
    const contentCenterY = minY + contentHeight / 2;

    // Calculate scale to fit content with padding (80% of container)
    const padding = 0.8;
    const scaleX = (containerSize.width * padding) / contentWidth;
    const scaleY = (containerSize.height * padding) / contentHeight;
    // Use the smaller scale to ensure content fits, but cap at 1 (don't zoom in beyond 100%)
    const fitScale = Math.min(scaleX, scaleY, 1);
    // For large frames (like screens), zoom out to fit; minimum 0.15 to keep usable
    const newScale = Math.max(fitScale, 0.15);

    // Position so content is centered in the container at the new scale
    const newX = (containerSize.width / 2) - (contentCenterX * newScale);
    const newY = (containerSize.height / 2) - (contentCenterY * newScale);

    setScale(newScale);
    setStagePosition({ x: newX, y: newY });
    hasCenteredRef.current = true;
  }, [elements, containerSize.width, containerSize.height]);

  const handleZoomIn = () => setScale(s => Math.min(s * 1.15, 5));
  const handleZoomOut = () => setScale(s => Math.max(s / 1.15, 0.1));
  const handleResetView = () => { setScale(1); hasCenteredRef.current = false; };

  // Store current scale and position in refs for wheel handler (to avoid stale closures)
  const scaleRef = useRef(scale);
  const stagePositionRef = useRef(stagePosition);

  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { stagePositionRef.current = stagePosition; }, [stagePosition]);

  // Attach wheel listener with passive: false
  useEffect(() => {
    if (!isMounted) return;

    // Use requestAnimationFrame to ensure DOM is ready
    const rafId = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) {
        console.warn('Canvas container not found for wheel handler');
        return;
      }

      const handler = (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // Pinch-to-zoom on trackpad (ctrlKey is true for pinch gestures)
        if (e.ctrlKey || e.metaKey) {
          // ZOOM mode - zoom towards cursor
          const rect = container.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;

          const currentScale = scaleRef.current;
          const currentPos = stagePositionRef.current;

          const zoomSensitivity = 0.01;
          const zoomFactor = 1 - e.deltaY * zoomSensitivity;
          const newScale = Math.max(0.1, Math.min(5, currentScale * zoomFactor));

          const scaleRatio = newScale / currentScale;
          const newPosX = mouseX - (mouseX - currentPos.x) * scaleRatio;
          const newPosY = mouseY - (mouseY - currentPos.y) * scaleRatio;

          setScale(newScale);
          setStagePosition({ x: newPosX, y: newPosY });
        } else {
          // PAN mode - two-finger swipe on trackpad
          setStagePosition(prev => ({
            x: prev.x - e.deltaX,
            y: prev.y - e.deltaY,
          }));
        }
      };

      container.addEventListener('wheel', handler, { passive: false });

      // Store handler ref for cleanup
      (container as HTMLDivElement & { _wheelHandler?: (e: WheelEvent) => void })._wheelHandler = handler;
    });

    return () => {
      cancelAnimationFrame(rafId);
      const container = containerRef.current;
      if (container) {
        const handler = (container as HTMLDivElement & { _wheelHandler?: (e: WheelEvent) => void })._wheelHandler;
        if (handler) {
          container.removeEventListener('wheel', handler);
        }
      }
    };
  }, [isMounted]);

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;

    if (toolMode === 'pan' || e.button === 1) {
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, stageX: stagePosition.x, stageY: stagePosition.y };
    } else if (toolMode === 'select') {
      // Start selection rectangle - clear selection, text edit state, and crop state
      setSelectedIds([]);
      setTextEditState(null);
      setSelectedTextRegion(null);
      setCropState(null);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        selectionStartRef.current = { x, y };
        setSelectionRect({ startX: x, startY: y, x, y, w: 0, h: 0 });
      }
    }
  };

  useEffect(() => {
    if (!isPanning && !selectionRect) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isPanning && panStartRef.current) {
        setStagePosition({
          x: panStartRef.current.stageX + (e.clientX - panStartRef.current.x),
          y: panStartRef.current.stageY + (e.clientY - panStartRef.current.y),
        });
      }
      if (selectionRect && selectionStartRef.current) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const currentX = e.clientX - rect.left;
          const currentY = e.clientY - rect.top;
          const x = Math.min(selectionStartRef.current.x, currentX);
          const y = Math.min(selectionStartRef.current.y, currentY);
          const w = Math.abs(currentX - selectionStartRef.current.x);
          const h = Math.abs(currentY - selectionStartRef.current.y);
          setSelectionRect({ ...selectionRect, x, y, w, h });
        }
      }
    };

    const handleMouseUp = () => {
      if (selectionRect && selectionRect.w > 5 && selectionRect.h > 5) {
        // Find elements inside selection
        const selected: string[] = [];
        elements.forEach(el => {
          const elLeft = el.x * scale + stagePosition.x;
          const elTop = el.y * scale + stagePosition.y;
          const elRight = elLeft + el.width * scale;
          const elBottom = elTop + el.height * scale;

          if (elLeft < selectionRect.x + selectionRect.w && elRight > selectionRect.x &&
            elTop < selectionRect.y + selectionRect.h && elBottom > selectionRect.y) {
            selected.push(el.id);
          }
        });
        setSelectedIds(selected);
      }
      setIsPanning(false);
      setSelectionRect(null);
      panStartRef.current = null;
      selectionStartRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning, selectionRect, elements, scale, stagePosition]);

  const handleElementChange = (id: string, newAttrs: Partial<CanvasElement>) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, ...newAttrs } as CanvasElement : el));
  };

  const handleElementSelect = (id: string, e?: React.MouseEvent) => {
    // Shift+click to add/remove from selection
    if (e?.shiftKey) {
      setSelectedIds(prev => {
        if (prev.includes(id)) {
          // Remove from selection
          return prev.filter(i => i !== id);
        } else {
          // Add to selection
          return [...prev, id];
        }
      });
    } else {
      // Regular click - single select
      setSelectedIds([id]);
    }
    // Clear text edit state and crop state when selection changes
    if (textEditState && textEditState.elementId !== id) {
      setTextEditState(null);
    }
    if (cropState && cropState.elementId !== id) {
      setCropState(null);
    }
  };

  // Track unsaved changes - compare sanitized versions to avoid false positives
  const hasUnsavedChangesRef = useRef(false);
  useEffect(() => {
    if (canvasData && elements.length > 0) {
      // Sanitize both to ensure fair comparison (raw data might be missing defaults)
      const currentElementsJson = JSON.stringify(elements);
      const originalElementsJson = JSON.stringify(sanitizeElements(canvasData.elements || []));
      const hasChanges = currentElementsJson !== originalElementsJson;

      // Only log when there's a change to avoid spam
      if (hasChanges !== hasUnsavedChanges) {
        console.log('[CANVAS_LIVE_DEBUG] hasUnsavedChanges changed to:', hasChanges, {
          localCount: elements.length,
          serverCount: canvasData.elements?.length || 0,
        });
      }

      setHasUnsavedChanges(hasChanges);
      hasUnsavedChangesRef.current = hasChanges;
    }
  }, [elements, canvasData, hasUnsavedChanges]);

  // Calculate next image position based on existing elements
  const getNextImagePosition = useCallback((imgWidth: number, imgHeight: number) => {
    const PADDING = 24;

    if (elements.length === 0) {
      // First image - center in visible area
      const centerX = (containerSize.width / 2 - stagePosition.x) / scale - imgWidth / 2;
      const centerY = (containerSize.height / 2 - stagePosition.y) / scale - imgHeight / 2;
      return { x: centerX, y: centerY };
    }

    // Find the rightmost edge of existing elements
    let maxRight = -Infinity;
    let topAtMaxRight = 0;
    elements.forEach(el => {
      const right = el.x + el.width;
      if (right > maxRight) {
        maxRight = right;
        topAtMaxRight = el.y;
      }
    });

    // Place new image to the right of the rightmost element with padding
    return { x: maxRight + PADDING, y: topAtMaxRight };
  }, [elements, containerSize, stagePosition, scale]);

  // Handle paste from clipboard
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    // Don't interfere with input fields
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        // Mark as user editing to prevent polling from overwriting during paste
        isUserEditingRef.current = true;

        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            // Scale proportionally if larger than max size
            const maxSize = 800;
            let imgWidth = img.width;
            let imgHeight = img.height;
            if (imgWidth > maxSize || imgHeight > maxSize) {
              const scaleFactor = Math.min(maxSize / imgWidth, maxSize / imgHeight);
              imgWidth = Math.round(imgWidth * scaleFactor);
              imgHeight = Math.round(imgHeight * scaleFactor);
            }
            const { x, y } = getNextImagePosition(imgWidth, imgHeight);

            const newElement: CanvasElement = {
              id: `img-${Date.now()}`,
              type: 'image',
              src: event.target?.result as string,
              x, y,
              width: imgWidth,
              height: imgHeight,
              rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, locked: false,
              name: `pasted-image-${Date.now()}.png`,
            };
            setElements(prev => [...prev, newElement]);
            setHasUnsavedChanges(true); // Immediately mark as unsaved
            toast.success('Image pasted');
            
            // Clear editing flag after a brief delay to allow state to settle
            setTimeout(() => {
              isUserEditingRef.current = false;
            }, 500);
          };
          img.src = event.target?.result as string;
        };
        reader.readAsDataURL(file);
        break; // Only paste first image
      }
    }
  }, [getNextImagePosition]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Ctrl/Cmd + S to save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (!isSavingRef.current) {
          document.getElementById('canvas-save-btn')?.click();
        }
        return;
      }

      // V without modifier = select tool, with modifier = paste (handled by paste event)
      if (e.key.toLowerCase() === 'v' && !e.metaKey && !e.ctrlKey) {
        setToolMode('select');
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'h': setToolMode('pan'); break;
        case 'escape':
          setSelectedIds([]);
          setTextEditState(null);
          setSelectedTextRegion(null);
          setCropState(null);
          break;
        case 'delete': case 'backspace':
          if (selectedIds.length > 0) {
            setElements(prev => prev.filter(el => !selectedIds.includes(el.id)));
            setSelectedIds([]);
            setTextEditState(null);
            setSelectedTextRegion(null);
            setCropState(null);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', handlePaste);
    };
  }, [selectedIds, handlePaste]);

  const handleSave = useCallback(async () => {
    if (!canvasData || !onSave) {
      toast.error('Cannot save - missing data or save handler');
      return;
    }

    setIsSaving(true);

    try {
      // Create updated canvas data with current elements
      // Base64 images are stored directly in the JSON
      const updatedCanvasData: CanvasData = {
        ...canvasData,
        elements: elements,
      };

      // Save the JSON
      await onSave(JSON.stringify(updatedCanvasData, null, 2));

      // Update canvasData to match saved state
      setCanvasData(updatedCanvasData);
      setHasUnsavedChanges(false);

      toast.success('Canvas saved');
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save canvas');
    } finally {
      setIsSaving(false);
    }
  }, [canvasData, elements, onSave]);

  const handleUploadClick = () => fileInputRef.current?.click();

  // Add a new frame to the canvas
  // Frame presets organized by category
  const framePresets = useMemo(() => [
    {
      category: 'Social Media', items: [
        { name: 'Instagram Post', width: 1080, height: 1080 },
        { name: 'Instagram Story', width: 1080, height: 1920 },
        { name: 'Instagram Reel', width: 1080, height: 1920 },
        { name: 'TikTok', width: 1080, height: 1920 },
        { name: 'Twitter Post', width: 1200, height: 675 },
        { name: 'Twitter Header', width: 1500, height: 500 },
        { name: 'Facebook Post', width: 1200, height: 630 },
        { name: 'Facebook Cover', width: 820, height: 312 },
        { name: 'LinkedIn Post', width: 1200, height: 627 },
        { name: 'LinkedIn Cover', width: 1584, height: 396 },
        { name: 'Pinterest Pin', width: 1000, height: 1500 },
        { name: 'YouTube Thumbnail', width: 1280, height: 720 },
        { name: 'YouTube Shorts', width: 1080, height: 1920 },
      ]
    },
    {
      category: 'Devices', items: [
        { name: 'iPhone 15 Pro Max', width: 1290, height: 2796 },
        { name: 'iPhone 15 Pro', width: 1179, height: 2556 },
        { name: 'iPhone 15', width: 1179, height: 2556 },
        { name: 'iPhone 14', width: 1170, height: 2532 },
        { name: 'iPhone SE', width: 750, height: 1334 },
        { name: 'iPad Pro 12.9"', width: 2048, height: 2732 },
        { name: 'iPad Pro 11"', width: 1668, height: 2388 },
        { name: 'Android Phone', width: 1080, height: 2400 },
      ]
    },
    {
      category: 'Design', items: [
        { name: 'Dribbble Shot', width: 400, height: 300 },
        { name: 'Dribbble Shot HD', width: 800, height: 600 },
        { name: 'Behance Project', width: 1400, height: 788 },
        { name: 'App Icon', width: 1024, height: 1024 },
        { name: 'Favicon', width: 512, height: 512 },
        { name: 'Open Graph', width: 1200, height: 630 },
      ]
    },
    {
      category: 'Print', items: [
        { name: 'Business Card', width: 1050, height: 600 },
        { name: 'Poster 18×24', width: 1800, height: 2400 },
        { name: 'A4', width: 2480, height: 3508 },
        { name: 'Square', width: 1000, height: 1000 },
      ]
    },
  ], []);

  const handleAddFrame = useCallback((width: number = 400, height: number = 300, presetName?: string) => {
    const { x, y } = getNextImagePosition(width, height);
    const frameCount = elements.filter(e => e.type === 'frame').length + 1;

    const newFrame: FrameCanvasElement = {
      id: `frame-${Date.now()}`,
      type: 'frame',
      x,
      y,
      width,
      height,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      name: presetName || `Frame ${frameCount}`,
      backgroundColor: undefined, // Transparent by default
    };
    setElements(prev => [...prev, newFrame]);
    setSelectedIds([newFrame.id]);
    toast.success('Frame added');
  }, [elements, getNextImagePosition]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Scale proportionally if larger than max size
        const maxSize = 800;
        let imgWidth = img.width;
        let imgHeight = img.height;
        if (imgWidth > maxSize || imgHeight > maxSize) {
          const scaleFactor = Math.min(maxSize / imgWidth, maxSize / imgHeight);
          imgWidth = Math.round(imgWidth * scaleFactor);
          imgHeight = Math.round(imgHeight * scaleFactor);
        }
        const { x, y } = getNextImagePosition(imgWidth, imgHeight);

        const newElement: CanvasElement = {
          id: `img-${Date.now()}`,
          type: 'image',
          src: event.target?.result as string,
          x, y,
          width: imgWidth,
          height: imgHeight,
          rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, locked: false,
          name: file.name,
        };
        setElements(prev => [...prev, newElement]);
        toast.success(`Added ${file.name}`);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // AI Image Generation
  const handleAIGenerate = async () => {
    if (!generatePrompt.trim()) return;

    setIsGenerating(true);
    setGeneratedPreviews([]);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/canvas-ai/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          prompt: generatePrompt,
          num_images: 2,
          aspect_ratio: '1:1',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Generation failed');
      }

      const result = await response.json();

      if (result.success && result.images?.length > 0) {
        setGeneratedPreviews(result.images);
        toast.success(`Generated ${result.images.length} images!`);
      } else {
        toast.error(result.error || 'Failed to generate images');
      }
    } catch (err) {
      console.error('AI generate error:', err);
      toast.error('Failed to generate images: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsGenerating(false);
    }
  };

  // Add generated image to canvas
  const addGeneratedImageToCanvas = (imageSrc: string) => {
    const img = new Image();
    img.onload = () => {
      const maxSize = 512;
      let imgWidth = img.width;
      let imgHeight = img.height;
      if (imgWidth > maxSize || imgHeight > maxSize) {
        const scaleFactor = Math.min(maxSize / imgWidth, maxSize / imgHeight);
        imgWidth = Math.round(imgWidth * scaleFactor);
        imgHeight = Math.round(imgHeight * scaleFactor);
      }
      const { x, y } = getNextImagePosition(imgWidth, imgHeight);

      const newElement: CanvasElement = {
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'image',
        src: imageSrc,
        x, y,
        width: imgWidth,
        height: imgHeight,
        rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, locked: false,
        name: `generated-${Date.now()}.webp`,
      };
      setElements(prev => [...prev, newElement]);
      toast.success('Added to canvas');
    };
    img.src = imageSrc;
  };

  if (!isMounted) {
    return <div className="flex items-center justify-center h-full w-full bg-card"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  // If no content AND no canvasData yet, show loading state
  // The useEffect creates empty canvas structure when content is null/empty
  if (!content && !canvasData) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-4 bg-background">
        <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
        <div className="text-muted-foreground text-center text-sm">
          Loading canvas...
        </div>
      </div>
    );
  }

  const selectedElement = selectedIds.length === 1 ? elements.find(el => el.id === selectedIds[0]) : null;

  return (
    <div className={cn("flex flex-col h-full w-full bg-background", className)} style={canvasData?.background ? { backgroundColor: canvasData.background } : undefined}>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={0}>
            <div className="flex items-center border border-border rounded-full px-1 py-0.5">
              <Tooltip><TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className={cn("h-7 w-7 rounded-full", toolMode === 'select' && "bg-primary text-primary-foreground")} onClick={() => setToolMode('select')}>
                  <MousePointer2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger><TooltipContent>Select (V)</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className={cn("h-7 w-7 rounded-full", toolMode === 'pan' && "bg-primary text-primary-foreground")} onClick={() => setToolMode('pan')}>
                  <Hand className="h-4 w-4" />
                </Button>
              </TooltipTrigger><TooltipContent>Pan (H)</TooltipContent></Tooltip>
            </div>

            <div className="flex items-center border border-border rounded-full px-1 py-0.5">
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={handleZoomOut}><Minus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Zoom Out</TooltipContent></Tooltip>
              <span className="text-xs text-muted-foreground px-2 min-w-12 text-center">{Math.round(scale * 100)}%</span>
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={handleZoomIn}><Plus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Zoom In</TooltipContent></Tooltip>
            </div>

            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleResetView}><Maximize className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Reset View</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button id="canvas-save-btn" variant="ghost" size="icon" className={cn("h-8 w-8 relative", hasUnsavedChanges && "text-primary")} onClick={handleSave} disabled={isSaving || !onSave}>{isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{hasUnsavedChanges && <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-primary rounded-full" />}</Button></TooltipTrigger><TooltipContent>{isSaving ? 'Saving...' : hasUnsavedChanges ? 'Save changes (⌘S)' : 'No changes'}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleUploadClick}><ImagePlus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Add Image</TooltipContent></Tooltip>
            {/* Add Frame with presets */}
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <Frame className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Add Frame</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-56 p-1 max-h-96 overflow-y-auto" align="start">
                {/* Custom frame at top */}
                <button
                  className="w-full flex items-center px-2 py-1.5 text-sm hover:bg-accent rounded-lg transition-colors text-left mb-1"
                  onClick={() => handleAddFrame(400, 300)}
                >
                  Custom
                </button>

                {framePresets.map((category) => (
                  <div key={category.category}>
                    <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">
                      {category.category}
                    </div>
                    {category.items.map((preset) => (
                      <button
                        key={preset.name}
                        className="w-full flex items-center justify-between px-2 py-1.5 text-sm hover:bg-accent rounded-lg transition-colors text-left"
                        onClick={() => handleAddFrame(preset.width, preset.height, preset.name)}
                      >
                        <span>{preset.name}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">{preset.width}×{preset.height}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </PopoverContent>
            </Popover>

            {/* AI Generate */}
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <Wand2 className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Generate with AI</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-80 p-3" align="end">
                <div className="space-y-3">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Quick Image Generation</div>
                  <Textarea
                    placeholder="Describe the image you want to create..."
                    value={generatePrompt}
                    onChange={(e) => setGeneratePrompt(e.target.value)}
                    className="min-h-[80px] resize-none shadow-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.metaKey && generatePrompt.trim()) {
                        handleAIGenerate();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={handleAIGenerate}
                    disabled={!generatePrompt.trim() || isGenerating}
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Generating...
                      </>
                    ) : (
                      'Generate'
                    )}
                  </Button>

                  {/* Generated previews */}
                  {generatedPreviews.length > 0 && (
                    <div className="grid grid-cols-2 gap-2 pt-2">
                      {generatedPreviews.map((src, idx) => (
                        <div
                          key={idx}
                          onClick={() => addGeneratedImageToCanvas(src)}
                          style={{ borderColor: 'var(--border)' }}
                          className="relative aspect-square rounded-lg overflow-hidden border outline-none transition-colors group cursor-pointer"
                        >
                          <img src={src} alt={`Generated ${idx + 1}`} className="w-full h-full object-cover" />
                          <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <Plus className="h-3 w-3" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </TooltipProvider>
        </div>
        <div className="text-sm text-muted-foreground">{canvasData?.name || fileName?.replace('.kanvax', '')}</div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden bg-background"
        style={{
          cursor: isPanning ? 'grabbing' : toolMode === 'pan' ? 'grab' : selectionRect ? 'crosshair' : 'default',
          touchAction: 'none', // Prevent default touch behaviors
        }}
        onMouseDown={handleCanvasMouseDown}
      >
        {/* Grid - subtle */}
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: 'linear-gradient(var(--foreground) 1px, transparent 1px), linear-gradient(90deg, var(--foreground) 1px, transparent 1px)',
          backgroundSize: `${50 * scale}px ${50 * scale}px`,
          backgroundPosition: `${stagePosition.x}px ${stagePosition.y}px`,
          opacity: 0.02,
        }} />

        {elements.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-muted-foreground">
              <ImagePlus className="h-16 w-16 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">Canvas is empty</p>
              <p className="text-sm mt-1">Add images to get started</p>
            </div>
          </div>
        )}

        {/* Render order: Frame backgrounds -> Images (clipped if inside frame) -> Frame borders on top */}
        {(() => {
          const frames = elements.filter(el => el.type === 'frame') as FrameCanvasElement[];
          const images = elements.filter(el => el.type === 'image') as ImageCanvasElement[];

          // Helper: check if image overlaps with frame (any percentage)
          const getOverlappingFrame = (img: ImageCanvasElement): FrameCanvasElement | null => {
            for (const frame of frames) {
              const imgRight = img.x + img.width;
              const imgBottom = img.y + img.height;
              const frameRight = frame.x + frame.width;
              const frameBottom = frame.y + frame.height;

              // Check if any part overlaps
              if (img.x < frameRight && imgRight > frame.x && img.y < frameBottom && imgBottom > frame.y) {
                return frame;
              }
            }
            return null;
          };

          // Calculate clip-path for image relative to frame (in screen coords)
          const getClipPath = (img: ImageCanvasElement, frame: FrameCanvasElement): string => {
            // Image position in screen coords
            const imgScreenX = img.x * scale + stagePosition.x;
            const imgScreenY = img.y * scale + stagePosition.y;
            const imgScreenW = img.width * scale;
            const imgScreenH = img.height * scale;

            // Frame position in screen coords
            const frameScreenX = frame.x * scale + stagePosition.x;
            const frameScreenY = frame.y * scale + stagePosition.y;
            const frameScreenW = frame.width * scale;
            const frameScreenH = frame.height * scale;

            // Calculate clip rect relative to image element (0-100%)
            const clipLeft = Math.max(0, (frameScreenX - imgScreenX) / imgScreenW * 100);
            const clipTop = Math.max(0, (frameScreenY - imgScreenY) / imgScreenH * 100);
            const clipRight = Math.min(100, (frameScreenX + frameScreenW - imgScreenX) / imgScreenW * 100);
            const clipBottom = Math.min(100, (frameScreenY + frameScreenH - imgScreenY) / imgScreenH * 100);

            return `polygon(${clipLeft}% ${clipTop}%, ${clipRight}% ${clipTop}%, ${clipRight}% ${clipBottom}%, ${clipLeft}% ${clipBottom}%)`;
          };

          return (
            <>
              {/* 1. Frame backgrounds (z-index 1) */}
              {frames.map((frame) => (
                <div
                  key={`frame-bg-${frame.id}`}
                  style={{
                    position: 'absolute',
                    left: frame.x * scale + stagePosition.x,
                    top: frame.y * scale + stagePosition.y,
                    width: frame.width * scale,
                    height: frame.height * scale,
                    backgroundColor: frame.backgroundColor || 'transparent',
                    borderRadius: '4px',
                    zIndex: 1,
                    pointerEvents: 'none',
                  }}
                />
              ))}

              {/* 2. Images (z-index 2) - clipped if overlapping with frame */}
              {images.map((img) => {
                const overlappingFrame = getOverlappingFrame(img);
                const clipPath = overlappingFrame ? getClipPath(img, overlappingFrame) : undefined;

                return (
                  <CanvasImageElement
                    key={img.id}
                    element={img}
                    isSelected={selectedIds.includes(img.id)}
                    onSelect={(e) => handleElementSelect(img.id, e)}
                    onChange={(newAttrs) => handleElementChange(img.id, newAttrs)}
                    authToken={authToken}
                    sandboxId={sandboxId}
                    scale={scale}
                    stagePosition={stagePosition}
                    isProcessing={processingElementId === img.id}
                    clipPath={clipPath}
                    frames={frames}
                    onSnapChange={setSnapGuides}
                  />
                );
              })}

              {/* 3. Frame borders/controls (z-index 10) - always on top */}
              {frames.map((frame) => (
                <CanvasFrameElement
                  key={frame.id}
                  element={frame}
                  isSelected={selectedIds.includes(frame.id)}
                  onSelect={(e) => handleElementSelect(frame.id, e)}
                  onChange={(newAttrs) => handleElementChange(frame.id, newAttrs)}
                  scale={scale}
                  stagePosition={stagePosition}
                  allElements={elements}
                  onMoveChildren={(childStartPositions, dx, dy) => {
                    // Move all children by the delta from their starting positions
                    setElements(prev => prev.map(el => {
                      const startPos = childStartPositions.find(c => c.id === el.id);
                      if (startPos) {
                        return { ...el, x: startPos.x + dx, y: startPos.y + dy };
                      }
                      return el;
                    }));
                  }}
                />
              ))}

            </>
          );
        })()}

        {/* Processing shimmer overlay - Show on ENTIRE FRAME if processing element is inside */}
        {processingElementId && (() => {
          const processingEl = elements.find(el => el.id === processingElementId);
          if (!processingEl || processingEl.type !== 'image') return null;

          // Check if processing image is inside a frame
          const frames = elements.filter(el => el.type === 'frame') as FrameCanvasElement[];
          let containingFrame: FrameCanvasElement | null = null;
          
          for (const frame of frames) {
            const imgRight = processingEl.x + processingEl.width;
            const imgBottom = processingEl.y + processingEl.height;
            const frameRight = frame.x + frame.width;
            const frameBottom = frame.y + frame.height;

            if (processingEl.x < frameRight && imgRight > frame.x && 
                processingEl.y < frameBottom && imgBottom > frame.y) {
              containingFrame = frame;
              break;
            }
          }

          // If inside frame, show shimmer on ENTIRE FRAME
          // If not inside frame, show shimmer on the image itself
          const targetEl = containingFrame || processingEl;
          const posX = targetEl.x * scale + stagePosition.x;
          const posY = targetEl.y * scale + stagePosition.y;
          const width = targetEl.width * scale;
          const height = targetEl.height * scale;

          console.log('[SHIMMER_DEBUG] Showing shimmer on:', { 
            processingId: processingElementId,
            showingOn: containingFrame ? 'FRAME' : 'IMAGE',
            frameId: containingFrame?.id,
            posX, 
            posY, 
            width, 
            height,
          });

          return (
            <div
              key={`shimmer-${processingElementId}`}
              style={{
                position: 'absolute',
                left: posX,
                top: posY,
                width,
                height,
                borderRadius: '4px',
                overflow: 'hidden',
                zIndex: 9999,
                pointerEvents: 'none',
              }}
            >
              <AIProcessingOverlay isVisible={true} />
            </div>
          );
        })()}

        {/* Snap Guides Overlay - shows alignment lines when dragging */}
        <SnapGuidesOverlay
          guides={snapGuides}
          frames={frames}
          scale={scale}
          stagePosition={stagePosition}
        />

        {/* Crop Overlay - rendered at canvas level for proper pan/zoom sync */}
        {cropState && selectedIds.length === 1 && (() => {
          const selectedElement = elements.find(el => el.id === cropState.elementId);
          if (!selectedElement) return null;

          return (
            <CropOverlay
              element={selectedElement}
              scale={scale}
              stagePosition={stagePosition}
              cropRect={cropState.cropRect}
              onCropChange={(newRect) => {
                setCropState({ elementId: cropState.elementId, cropRect: newRect });
              }}
            />
          );
        })()}

        {/* Text Edit Overlay - rendered at canvas level for proper pan/zoom sync */}
        {textEditState && selectedIds.length === 1 && (() => {
          const selectedElement = elements.find(el => el.id === textEditState.elementId);
          if (!selectedElement) return null;

          // The element dimensions vs actual image dimensions may differ (object-fit: contain)
          // We need to calculate where the image actually renders within the element
          const elementWidth = selectedElement.width;
          const elementHeight = selectedElement.height;
          const ocrWidth = textEditState.ocrImageSize.width;
          const ocrHeight = textEditState.ocrImageSize.height;

          // Calculate how image fits in element (object-fit: contain behavior)
          const elementAspect = elementWidth / elementHeight;
          const imageAspect = ocrWidth / ocrHeight;

          let displayWidth: number, displayHeight: number, offsetX: number, offsetY: number;

          if (imageAspect > elementAspect) {
            // Image is wider - fit to width, letterbox top/bottom
            displayWidth = elementWidth;
            displayHeight = elementWidth / imageAspect;
            offsetX = 0;
            offsetY = (elementHeight - displayHeight) / 2;
          } else {
            // Image is taller - fit to height, letterbox left/right
            displayHeight = elementHeight;
            displayWidth = elementHeight * imageAspect;
            offsetX = (elementWidth - displayWidth) / 2;
            offsetY = 0;
          }

          // Calculate the actual image position in screen coordinates
          const imageScreenX = (selectedElement.x + offsetX) * scale + stagePosition.x;
          const imageScreenY = (selectedElement.y + offsetY) * scale + stagePosition.y;
          const imageScreenWidth = displayWidth * scale;
          const imageScreenHeight = displayHeight * scale;

          // Scale factor from OCR coordinates to screen coordinates
          const scaleX = imageScreenWidth / ocrWidth;
          const scaleY = imageScreenHeight / ocrHeight;

          return (
            <svg
              className="absolute pointer-events-none z-50"
              style={{
                left: imageScreenX,
                top: imageScreenY,
                width: imageScreenWidth,
                height: imageScreenHeight,
              }}
              viewBox={`0 0 ${ocrWidth} ${ocrHeight}`}
              preserveAspectRatio="none"
            >
              {textEditState.regions.map((region) => {
                const isSelected = selectedTextRegion?.id === region.id;

                // Use polygon points for perspective-aware bounding box
                const polygon = region.polygon;
                if (!polygon || polygon.length < 4) return null;

                // Create SVG polygon points string
                const points = polygon.map(([x, y]) => `${x},${y}`).join(' ');

                return (
                  <polygon
                    key={region.id}
                    points={points}
                    className={cn(
                      "cursor-pointer transition-all pointer-events-auto",
                      isSelected
                        ? "fill-blue-500/20 stroke-blue-500"
                        : "fill-transparent stroke-blue-400/50 hover:stroke-blue-500 hover:fill-blue-500/10"
                    )}
                    style={{
                      strokeWidth: 2 / Math.min(scaleX, scaleY), // Keep stroke width consistent regardless of scale
                    }}
                    onClick={() => setSelectedTextRegion(region)}
                  >
                    <title>{region.text}</title>
                  </polygon>
                );
              })}
            </svg>
          );
        })()}

        {/* Selection rectangle - blue */}
        {selectionRect && selectionRect.w > 0 && selectionRect.h > 0 && (
          <div
            className="absolute border border-dashed border-blue-500 bg-blue-500/10 pointer-events-none"
            style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.w, height: selectionRect.h }}
          />
        )}

        {/* Floating AI toolbar - for selected IMAGE element */}
        {selectedIds.length === 1 && selectedElement && selectedElement.type === 'image' && (
          <FloatingToolbar
            element={selectedElement as ImageCanvasElement}
            scale={scale}
            stagePosition={stagePosition}
            onChange={(newAttrs) => handleElementChange(selectedElement.id, newAttrs)}
            onDuplicate={() => {
              const newEl = { ...selectedElement, id: `img-${Date.now()}`, x: selectedElement.x + selectedElement.width + 24, y: selectedElement.y };
              setElements(prev => [...prev, newEl]);
              setSelectedIds([newEl.id]);
            }}
            onDelete={() => {
              setElements(prev => prev.filter(el => el.id !== selectedElement.id));
              setSelectedIds([]);
              setTextEditState(null);
              setSelectedTextRegion(null);
              setCropState(null);
            }}
            onDownloadPng={() => {
              if (selectedElement.src.startsWith('data:')) {
                const link = document.createElement('a');
                link.href = selectedElement.src;
                link.download = (selectedElement.name || 'image').replace(/\.[^.]+$/, '') + '.png';
                link.click();
              } else {
                toast.info('Downloading from sandbox...');
              }
            }}
            onDownloadSvg={async () => {
              try {
                toast.info('Converting to SVG...');

                // Get base64 data
                let imageBase64 = selectedElement.src;
                if (!imageBase64.startsWith('data:')) {
                  toast.error('SVG conversion requires base64 image data');
                  return;
                }

                // Call backend API for SVG conversion
                const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/canvas-ai/convert-svg`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
                  },
                  body: JSON.stringify({
                    image_base64: imageBase64,
                    colormode: 'color',
                    mode: 'spline',
                  }),
                });

                if (!response.ok) {
                  const error = await response.text();
                  throw new Error(error || 'SVG conversion failed');
                }

                const result = await response.json();

                if (result.success && result.svg) {
                  // Download the SVG
                  const blob = new Blob([result.svg], { type: 'image/svg+xml' });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = (selectedElement.name || 'image').replace(/\.[^.]+$/, '') + '.svg';
                  link.click();
                  URL.revokeObjectURL(url);
                  toast.success('SVG downloaded!');
                } else {
                  toast.error(result.error || 'SVG conversion failed');
                }
              } catch (err) {
                console.error('SVG conversion error:', err);
                toast.error('Failed to convert to SVG: ' + (err instanceof Error ? err.message : 'Unknown error'));
              }
            }}
            onImageUpdate={(newSrc, newDimensions) => {
              // Non-destructive editing: Update the pending placeholder with actual image
              const newWidth = newDimensions?.width || selectedElement.width;
              const newHeight = newDimensions?.height || selectedElement.height;

              // Use ref for reliable access even if selection changed
              const currentPlaceholderId = pendingPlaceholderIdRef.current;
              if (currentPlaceholderId) {
                // Update the placeholder with the actual image
                setElements(prev => prev.map(el =>
                  el.id === currentPlaceholderId
                    ? {
                      ...el,
                      src: newSrc,
                      width: newWidth,
                      height: newHeight,
                      locked: false, // Unlock after processing
                      name: el.name.replace('_processing', '_processed'),
                    }
                    : el
                ));
                setSelectedIds([currentPlaceholderId]);
                pendingPlaceholderIdRef.current = null;
                setPendingPlaceholderId(null);
                setProcessingElementId(null);
              }
            }}
            onProcessingChange={(isProcessing, failed = false) => {
              if (isProcessing) {
                // Create placeholder element to the RIGHT immediately
                const gap = 20;
                const placeholderId = `placeholder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

                const placeholderElement: CanvasElement = {
                  id: placeholderId,
                  type: 'image',
                  src: '', // Empty src = loading state
                  x: selectedElement.x + selectedElement.width + gap,
                  y: selectedElement.y,
                  width: selectedElement.width,
                  height: selectedElement.height,
                  rotation: 0,
                  scaleX: 1,
                  scaleY: 1,
                  opacity: 1,
                  locked: true, // Lock during processing
                  visible: true,
                  name: `${selectedElement.name}_processing`,
                };

                setElements(prev => [...prev, placeholderElement]);
                pendingPlaceholderIdRef.current = placeholderId; // Store in ref for reliable access
                setPendingPlaceholderId(placeholderId);
                setProcessingElementId(placeholderId); // Show shimmer on placeholder, not original
              } else if (failed) {
                // Only cleanup on FAILURE - success is handled by onImageUpdate
                const currentPlaceholderId = pendingPlaceholderIdRef.current;
                if (currentPlaceholderId) {
                  setElements(prev => prev.filter(el => el.id !== currentPlaceholderId));
                }
                pendingPlaceholderIdRef.current = null;
                setPendingPlaceholderId(null);
                setProcessingElementId(null);
              }
              // On success (failed=false), onImageUpdate handles cleanup
            }}
            onOcrProcessing={(isProcessing) => {
              // OCR shimmer on SAME element - no duplicate created
              setProcessingElementId(isProcessing ? selectedElement.id : null);
            }}
            onTextEditStateChange={(state) => {
              if (state) {
                setTextEditState({ elementId: selectedElement.id, regions: state.regions, ocrImageSize: state.ocrImageSize });
              } else {
                setTextEditState(null);
                setSelectedTextRegion(null);
              }
            }}
            onTextRegionSelect={(region) => setSelectedTextRegion(region)}
            externalSelectedRegion={selectedTextRegion}
            onCropStateChange={(state) => {
              if (state) {
                setCropState({ elementId: selectedElement.id, cropRect: state.cropRect });
              } else {
                setCropState(null);
              }
            }}
            externalCropRect={cropState?.elementId === selectedElement.id ? cropState.cropRect : null}
            onCropCreate={(src, width, height) => {
              const newEl: CanvasElement = {
                id: `img-${Date.now()}`,
                type: 'image',
                src,
                x: selectedElement.x + selectedElement.width + 24,
                y: selectedElement.y,
                width,
                height,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                opacity: 1,
                locked: false,
                visible: true,
                name: `${selectedElement.name.replace(/\.[^.]+$/, '')}_crop.png`,
              };
              setElements(prev => [...prev, newEl]);
              setSelectedIds([newEl.id]);
              setCropState(null);
            }}
            authToken={authToken}
            sandboxId={sandboxId}
          />
        )}

        {/* Floating toolbar - for selected FRAME element */}
        {selectedIds.length === 1 && selectedElement && selectedElement.type === 'frame' && (
          <FrameFloatingToolbar
            element={selectedElement as FrameCanvasElement}
            elements={elements}
            scale={scale}
            stagePosition={stagePosition}
            onChange={(newAttrs) => handleElementChange(selectedElement.id, newAttrs)}
            onDuplicate={() => {
              const newEl: FrameCanvasElement = {
                ...(selectedElement as FrameCanvasElement),
                id: `frame-${Date.now()}`,
                x: selectedElement.x + selectedElement.width + 24,
              };
              setElements(prev => [...prev, newEl]);
              setSelectedIds([newEl.id]);
            }}
            onDelete={() => {
              setElements(prev => prev.filter(el => el.id !== selectedElement.id));
              setSelectedIds([]);
            }}
            onExportFrame={async () => {
              // Export frame as PNG - captures all images within frame bounds
              try {
                toast.info('Exporting frame...');
                const frame = selectedElement as FrameCanvasElement;

                // Create a canvas at frame dimensions
                const exportCanvas = document.createElement('canvas');
                exportCanvas.width = Math.round(frame.width);
                exportCanvas.height = Math.round(frame.height);
                const ctx = exportCanvas.getContext('2d');
                if (!ctx) throw new Error('Failed to get canvas context');

                // Fill background if set
                if (frame.backgroundColor && frame.backgroundColor !== 'transparent') {
                  ctx.fillStyle = frame.backgroundColor;
                  ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
                }

                // Find all images that intersect with this frame
                const frameLeft = frame.x;
                const frameTop = frame.y;
                const frameRight = frame.x + frame.width;
                const frameBottom = frame.y + frame.height;

                const imageElements = elements.filter(el => {
                  if (el.type !== 'image') return false;
                  const img = el as ImageCanvasElement;
                  // Check if image intersects with frame
                  const imgRight = img.x + img.width;
                  const imgBottom = img.y + img.height;
                  return img.x < frameRight && imgRight > frameLeft &&
                    img.y < frameBottom && imgBottom > frameTop;
                }) as ImageCanvasElement[];

                // Sort by z-index (order in array)
                const sortedImages = imageElements.sort((a, b) => {
                  return elements.indexOf(a) - elements.indexOf(b);
                });

                // Draw each image
                for (const imgEl of sortedImages) {
                  try {
                    let imgSrc = imgEl.src;

                    // Fetch image if it's a path
                    if (!imgSrc.startsWith('data:')) {
                      const url = sandboxId ? getSandboxFileUrl(sandboxId, imgSrc) : imgSrc;
                      const headers: Record<string, string> = {};
                      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
                      const response = await fetch(url, { credentials: 'include', headers });
                      if (!response.ok) continue;
                      const blob = await response.blob();
                      imgSrc = await new Promise<string>((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result as string);
                        reader.readAsDataURL(blob);
                      });
                    }

                    // Load and draw image
                    const img = new Image();
                    await new Promise<void>((resolve, reject) => {
                      img.onload = () => resolve();
                      img.onerror = reject;
                      img.src = imgSrc;
                    });

                    // Calculate position relative to frame
                    const drawX = imgEl.x - frame.x;
                    const drawY = imgEl.y - frame.y;

                    ctx.drawImage(img, drawX, drawY, imgEl.width, imgEl.height);
                  } catch (err) {
                    console.warn('Failed to draw image:', imgEl.name, err);
                  }
                }

                // Download the canvas
                const dataUrl = exportCanvas.toDataURL('image/png');
                const link = document.createElement('a');
                link.href = dataUrl;
                link.download = `${frame.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.png`;
                link.click();

                toast.success('Frame exported!');
              } catch (err) {
                console.error('Export error:', err);
                toast.error('Failed to export frame: ' + (err instanceof Error ? err.message : 'Unknown error'));
              }
            }}
            sandboxId={sandboxId}
            authToken={authToken}
          />
        )}

        {/* Multi-select toolbar */}
        {selectedIds.length > 1 && (
          <MultiSelectToolbar
            elements={elements.filter(el => selectedIds.includes(el.id))}
            scale={scale}
            stagePosition={stagePosition}
            onStartMerge={() => {
              // Get the first selected element's size for the merged result
              const selectedEls = elements.filter(el => selectedIds.includes(el.id));
              const firstEl = selectedEls[0];

              // Get bounds to position new image to the right
              const bounds = selectedEls.reduce((acc, el) => ({
                maxX: Math.max(acc.maxX, el.x + el.width),
                minY: Math.min(acc.minY, el.y),
              }), { maxX: -Infinity, minY: Infinity });

              // Create temporary placeholder element - use first image's size
              const tempId = `merge-temp-${Date.now()}`;
              const tempElement: CanvasElement = {
                id: tempId,
                type: 'image',
                src: '', // Empty - will show as loading placeholder
                name: 'Merging...',
                x: bounds.maxX + 24, // Place to the right of rightmost selected image
                y: bounds.minY,
                width: firstEl?.width || 400,
                height: firstEl?.height || 400,
                visible: true,
              };

              // KEEP original elements, just add the temp placeholder
              setElements(prev => [...prev, tempElement]);
              setSelectedIds([tempId]);
              setProcessingElementId(tempId); // Show shimmer on it

              return tempId;
            }}
            onMergeComplete={(tempId, mergedImageSrc) => {
              // Replace temp element with actual merged image
              setElements(prev => prev.map(el =>
                el.id === tempId
                  ? { ...el, src: mergedImageSrc, name: 'merged-image.png' }
                  : el
              ));
              setProcessingElementId(null);
            }}
            onMergeFailed={(tempId) => {
              // Remove the temp element on failure
              setElements(prev => prev.filter(el => el.id !== tempId));
              setSelectedIds([]);
              setProcessingElementId(null);
            }}
            onDelete={() => {
              setElements(prev => prev.filter(el => !selectedIds.includes(el.id)));
              setSelectedIds([]);
            }}
            onProcessingChange={(isProcessing) => {
              // Set processing for all selected elements
              setProcessingElementId(isProcessing ? selectedIds[0] : null);
            }}
            authToken={authToken}
            sandboxId={sandboxId}
          />
        )}
      </div>
    </div>
  );
}
