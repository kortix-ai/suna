'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  Lock,
  Unlock,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { useAuth } from '@/components/AuthProvider';

interface CanvasElement {
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

interface CanvasData {
  name: string;
  version: string;
  background: string;
  elements: CanvasElement[];
  width?: number;
  height?: number;
}

interface CanvasRendererProps {
  content: string | null;
  filePath?: string;
  fileName: string;
  sandboxId?: string;
  className?: string;
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
}: {
  element: CanvasElement;
  isSelected: boolean;
  onSelect: () => void;
  onChange: (newAttrs: Partial<CanvasElement>) => void;
  sandboxId?: string;
  scale: number;
  stagePosition: { x: number; y: number };
  authToken?: string;
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
    if (!element.src) return;
    if (element.src.startsWith('data:')) {
      setImageSrc(element.src);
      setLoading(false);
      return;
    }
    
    const loadImage = async () => {
      try {
        setLoading(true);
        setError(null);
        const url = sandboxId ? getSandboxFileUrl(sandboxId, element.src) : element.src;
        const headers: Record<string, string> = {};
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        const response = await fetch(url, { credentials: 'include', headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        setImageSrc(URL.createObjectURL(blob));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed');
      } finally {
        setLoading(false);
      }
    };
    loadImage();
  }, [element.src, sandboxId, authToken]);

  const posX = element.x * scale + stagePosition.x;
  const posY = element.y * scale + stagePosition.y;
  const width = element.width * scale;
  const height = element.height * scale;

  const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'resize' = 'move', handle?: string) => {
    if (element.locked && type === 'move') return;
    e.stopPropagation();
    e.preventDefault();
    onSelect();
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
        onChange({ x: dragState.startElemX + dx, y: dragState.startElemY + dy });
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

    const handleMouseUp = () => setDragState(null);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, scale, onChange]);

  if (loading) {
    return (
      <div style={{ position: 'absolute', left: posX, top: posY, width, height }} className="flex items-center justify-center bg-card/50 rounded">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
      }}
    >
      <div className={cn("w-full h-full rounded overflow-hidden", isSelected && "ring-2 ring-blue-500")}>
        <img src={imageSrc} alt={element.name} draggable={false} className="w-full h-full object-cover pointer-events-none" />
      </div>
      
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

export function CanvasRenderer({ content, filePath, fileName, sandboxId, className }: CanvasRendererProps) {
  const { session } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [canvasData, setCanvasData] = useState<CanvasData | null>(null);
  const [scale, setScale] = useState(1);
  const [stagePosition, setStagePosition] = useState({ x: 50, y: 50 });
  const [toolMode, setToolMode] = useState<'select' | 'pan'>('select');
  const [isPanning, setIsPanning] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [selectionRect, setSelectionRect] = useState<{ startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);
  const panStartRef = useRef<{ x: number; y: number; stageX: number; stageY: number } | null>(null);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
  const hasCenteredRef = useRef(false);
  
  const authToken = session?.access_token;

  useEffect(() => {
    if (content) {
      try {
        const parsed: CanvasData = JSON.parse(content);
        setCanvasData(parsed);
        setElements(parsed.elements || []);
        hasCenteredRef.current = false; // Reset so centering happens for new content
      } catch (e) {
        console.error('[CanvasRenderer] Parse error:', e);
      }
    }
  }, [content]);

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

  // Center canvas ONCE on initial load only
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
    
    // Position so content is centered in the container
    const newX = (containerSize.width / 2) - (contentCenterX * scale);
    const newY = (containerSize.height / 2) - (contentCenterY * scale);
    
    setStagePosition({ x: newX, y: newY });
    hasCenteredRef.current = true;
  }, [elements, containerSize.width, containerSize.height, scale]);

  const handleZoomIn = () => setScale(s => Math.min(s * 1.15, 5));
  const handleZoomOut = () => setScale(s => Math.max(s / 1.15, 0.1));
  const handleResetView = () => { setScale(1); hasCenteredRef.current = false; };

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    // Smooth zoom - multiply/divide by factor based on scroll direction
    const zoomFactor = 1 + Math.min(Math.abs(e.deltaY) * 0.001, 0.1);
    setScale(s => {
      const newScale = e.deltaY > 0 ? s / zoomFactor : s * zoomFactor;
      return Math.max(0.1, Math.min(5, newScale));
    });
  }, []);

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    
    if (toolMode === 'pan' || e.button === 1) {
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, stageX: stagePosition.x, stageY: stagePosition.y };
    } else if (toolMode === 'select') {
      // Start selection rectangle
      setSelectedIds([]);
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
    setElements(prev => prev.map(el => el.id === id ? { ...el, ...newAttrs } : el));
  };

  const handleElementSelect = (id: string) => setSelectedIds([id]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key.toLowerCase()) {
        case 'v': setToolMode('select'); break;
        case 'h': setToolMode('pan'); break;
        case 'escape': setSelectedIds([]); break;
        case 'delete': case 'backspace':
          if (selectedIds.length > 0) {
            setElements(prev => prev.filter(el => !selectedIds.includes(el.id)));
            setSelectedIds([]);
          }
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds]);

  const handleSave = async () => {
    if (!canvasData) return;
    toast.success('Canvas saved');
  };

  const handleUploadClick = () => fileInputRef.current?.click();
  
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const imgWidth = Math.min(img.width, 600);
        const imgHeight = Math.min(img.height, 600);
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

  if (!isMounted) {
    return <div className="flex items-center justify-center h-full w-full bg-card"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (!content) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-4 bg-card">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <div className="text-muted-foreground text-center">
          <p>No canvas content</p>
          <p className="text-sm">File: {filePath || 'unknown'}</p>
        </div>
      </div>
    );
  }

  if (!canvasData && content) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-4 bg-card">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <div className="text-muted-foreground text-center">Failed to parse canvas</div>
      </div>
    );
  }

  const selectedElement = selectedIds.length === 1 ? elements.find(el => el.id === selectedIds[0]) : null;

  return (
    <div className={cn("flex flex-col h-full w-full", className)} style={{ backgroundColor: canvasData?.background || '#1a1a1a' }}>
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
              <span className="text-xs text-muted-foreground px-2 min-w-[3rem] text-center">{Math.round(scale * 100)}%</span>
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={handleZoomIn}><Plus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Zoom In</TooltipContent></Tooltip>
            </div>

            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleResetView}><Maximize className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Reset View</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSave}><Save className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Save</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleUploadClick}><ImagePlus className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Add Image</TooltipContent></Tooltip>
          </TooltipProvider>
        </div>
        <div className="text-sm text-muted-foreground">{canvasData?.name || fileName?.replace('.kanvax', '')}</div>
      </div>

      {/* Canvas */}
      <div 
        ref={containerRef} 
        className="flex-1 relative overflow-hidden"
        style={{ cursor: isPanning ? 'grabbing' : toolMode === 'pan' ? 'grab' : selectionRect ? 'crosshair' : 'default' }}
        onMouseDown={handleCanvasMouseDown}
        onWheel={handleWheel}
      >
        {/* Grid */}
        <div className="absolute inset-0 pointer-events-none opacity-10" style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
          backgroundSize: `${50 * scale}px ${50 * scale}px`,
          backgroundPosition: `${stagePosition.x}px ${stagePosition.y}px`,
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

        {elements.map((element) => (
          <CanvasImageElement
            key={element.id}
            element={element}
            isSelected={selectedIds.includes(element.id)}
            onSelect={() => handleElementSelect(element.id)}
            onChange={(newAttrs) => handleElementChange(element.id, newAttrs)}
            authToken={authToken}
            sandboxId={sandboxId}
            scale={scale}
            stagePosition={stagePosition}
          />
        ))}

        {/* Selection rectangle - blue */}
        {selectionRect && selectionRect.w > 0 && selectionRect.h > 0 && (
          <div
            className="absolute border border-dashed border-blue-500 bg-blue-500/10 pointer-events-none"
            style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.w, height: selectionRect.h }}
          />
        )}

        {/* Floating toolbar */}
        {selectedElement && (
          <div
            style={{
              position: 'absolute',
              left: selectedElement.x * scale + stagePosition.x + (selectedElement.width * scale) / 2,
              top: selectedElement.y * scale + stagePosition.y + selectedElement.height * scale + 12,
              transform: 'translateX(-50%)',
              zIndex: 100,
            }}
            className="flex items-center gap-1 bg-card border border-border rounded-full px-2 py-1"
          >
            {/* File info */}
            <span className="text-xs text-muted-foreground px-2 truncate max-w-[120px]">{selectedElement.name}</span>
            <span className="text-xs text-muted-foreground">{Math.round(selectedElement.width)}×{Math.round(selectedElement.height)}</span>
            
            <div className="w-px h-4 bg-border mx-1" />

            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full" onClick={() => {
              const newEl = { ...selectedElement, id: `img-${Date.now()}`, x: selectedElement.x + selectedElement.width + 24, y: selectedElement.y };
              setElements(prev => [...prev, newEl]);
              setSelectedIds([newEl.id]);
            }}><Copy className="h-3 w-3" /></Button>

            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full" onClick={() => handleElementChange(selectedElement.id, { locked: !selectedElement.locked })}>
              {selectedElement.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
            </Button>

            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full" onClick={() => {
              setElements(prev => { const idx = prev.findIndex(el => el.id === selectedElement.id); if (idx === -1 || idx === prev.length - 1) return prev; const arr = [...prev]; const [el] = arr.splice(idx, 1); arr.push(el); return arr; });
            }}><ArrowUp className="h-3 w-3" /></Button>

            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full" onClick={() => {
              setElements(prev => { const idx = prev.findIndex(el => el.id === selectedElement.id); if (idx <= 0) return prev; const arr = [...prev]; const [el] = arr.splice(idx, 1); arr.unshift(el); return arr; });
            }}><ArrowDown className="h-3 w-3" /></Button>

            <div className="w-px h-4 bg-border mx-1" />

            <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full" onClick={() => { setElements(prev => prev.filter(el => el.id !== selectedElement.id)); setSelectedIds([]); }}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
