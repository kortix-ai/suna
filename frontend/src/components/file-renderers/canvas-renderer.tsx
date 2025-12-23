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
  Lock,
  Unlock,
  MoveUp,
  MoveDown,
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

// Construct sandbox file URL
function getSandboxFileUrl(sandboxId: string | undefined, path: string): string {
  if (!sandboxId) {
    console.warn('[CanvasRenderer] No sandboxId for image:', path);
    return path;
  }
  
  let normalizedPath = path;
  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.substring(1);
  }
  if (normalizedPath.startsWith('workspace/')) {
    normalizedPath = normalizedPath.substring(10);
  }
  normalizedPath = `/workspace/${normalizedPath}`;
  
  const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || '';
  return `${baseUrl}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(normalizedPath)}`;
}

// Simple image display component (no Konva dependency)
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
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; elemX: number; elemY: number } | null>(null);

  useEffect(() => {
    if (!element.src) return;
    
    // If src is base64, use directly
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
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        }
        
        const response = await fetch(url, { 
          credentials: 'include',
          headers,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        setImageSrc(objectUrl);
      } catch (err) {
        console.error('[CanvasImage] Load error:', element.src, err);
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    };
    
    loadImage();
  }, [element.src, sandboxId, authToken]);

  // Calculate position on canvas
  const posX = element.x * scale + stagePosition.x;
  const posY = element.y * scale + stagePosition.y;
  const width = element.width * scale;
  const height = element.height * scale;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (element.locked) return;
    e.stopPropagation();
    onSelect();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      elemX: element.x,
      elemY: element.y,
    };
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = (e.clientX - dragStartRef.current.x) / scale;
      const dy = (e.clientY - dragStartRef.current.y) / scale;
      onChange({
        x: dragStartRef.current.elemX + dx,
        y: dragStartRef.current.elemY + dy,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, scale, onChange]);

  if (loading) {
    return (
      <div
        style={{
          position: 'absolute',
          left: posX,
          top: posY,
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.3)',
          borderRadius: 4,
        }}
      >
        <Loader2 className="h-6 w-6 animate-spin text-white/70" />
      </div>
    );
  }

  if (error || !imageSrc) {
    return (
      <div
        style={{
          position: 'absolute',
          left: posX,
          top: posY,
          width,
          height,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(239, 68, 68, 0.2)',
          borderRadius: 4,
          border: '1px dashed rgba(239, 68, 68, 0.5)',
        }}
      >
        <AlertCircle className="h-5 w-5 text-red-400 mb-1" />
        <span className="text-xs text-red-400">Failed to load</span>
      </div>
    );
  }

  return (
    <div
      onMouseDown={handleMouseDown}
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
      {/* Image with selection border */}
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 4,
          overflow: 'hidden',
          boxShadow: isSelected ? '0 0 0 2px #3b82f6' : 'none',
        }}
      >
        <img
          src={imageSrc}
          alt={element.name}
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',
          }}
        />
      </div>
      
      {/* Resize handles - outside overflow */}
      {isSelected && !element.locked && (
        <>
          <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-nw-resize z-10" />
          <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-ne-resize z-10" />
          <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-sw-resize z-10" />
          <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-se-resize z-10" />
          <div className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-w-resize z-10" />
          <div className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-e-resize z-10" />
          <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-n-resize z-10" />
          <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-s-resize z-10" />
        </>
      )}
    </div>
  );
}

/**
 * Canvas Renderer - LIVE EDITOR for .kanvax files
 * Uses HTML/CSS instead of Konva for better compatibility
 */
export function CanvasRenderer({
  content,
  filePath,
  fileName,
  sandboxId,
  className,
}: CanvasRendererProps) {
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
  const panStartRef = useRef<{ x: number; y: number; stageX: number; stageY: number } | null>(null);
  
  const authToken = session?.access_token;

  // Parse canvas data from content
  useEffect(() => {
    console.log('[CanvasRenderer] Content received:', { 
      hasContent: !!content, 
      contentType: typeof content,
      contentLength: content?.length,
      sandboxId,
      filePath,
    });
    
    if (content) {
      try {
        const parsed: CanvasData = JSON.parse(content);
        console.log('[CanvasRenderer] Parsed canvas:', {
          name: parsed.name,
          elementCount: parsed.elements?.length || 0,
          elements: parsed.elements,
          background: parsed.background,
        });
        setCanvasData(parsed);
        setElements(parsed.elements || []);
      } catch (e) {
        console.error('[CanvasRenderer] Failed to parse canvas:', e, 'Content was:', content?.substring(0, 200));
      }
    }
  }, [content, sandboxId, filePath]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Track container size for centering
  useEffect(() => {
    if (!containerRef.current) return;
    
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    updateSize();
    
    return () => observer.disconnect();
  }, []);

  // Center elements when canvas loads
  useEffect(() => {
    if (elements.length > 0 && containerSize.width > 0) {
      // Calculate bounding box of all elements
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
      
      // Center in container
      const centerX = containerSize.width / 2 - contentCenterX * scale;
      const centerY = containerSize.height / 2 - contentCenterY * scale;
      
      setStagePosition({ x: centerX, y: centerY });
    }
  }, [elements.length, containerSize.width, containerSize.height]); // Only on initial load

  // Zoom controls
  const handleZoomIn = () => setScale(s => Math.min(s + 0.1, 5));
  const handleZoomOut = () => setScale(s => Math.max(s - 0.1, 0.1));
  const handleResetView = () => {
    setScale(1);
    setStagePosition({ x: 50, y: 50 });
  };

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale(s => Math.max(0.1, Math.min(5, s + delta)));
  }, []);

  // Pan handling
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    // Clicked on empty space
    if (e.target === e.currentTarget) {
      setSelectedIds([]);
    }
    
    if (toolMode === 'pan' || e.button === 1) { // Middle mouse or pan mode
      setIsPanning(true);
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        stageX: stagePosition.x,
        stageY: stagePosition.y,
      };
    }
  };

  useEffect(() => {
    if (!isPanning) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panStartRef.current) return;
      setStagePosition({
        x: panStartRef.current.stageX + (e.clientX - panStartRef.current.x),
        y: panStartRef.current.stageY + (e.clientY - panStartRef.current.y),
      });
    };

    const handleMouseUp = () => {
      setIsPanning(false);
      panStartRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning]);

  // Element changes
  const handleElementChange = (id: string, newAttrs: Partial<CanvasElement>) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, ...newAttrs } : el));
  };

  const handleElementSelect = (id: string) => {
    setSelectedIds([id]);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      switch (e.key.toLowerCase()) {
        case 'v': setToolMode('select'); break;
        case 'h': setToolMode('pan'); break;
        case 'escape': setSelectedIds([]); break;
        case 'delete':
        case 'backspace':
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

  // Save handler
  const handleSave = async () => {
    if (!canvasData) return;
    const updatedData = { ...canvasData, elements, updated_at: new Date().toISOString() };
    console.log('[CanvasRenderer] Save data:', updatedData);
    toast.success('Canvas saved');
  };

  // Upload handler - add image to canvas
  const handleUploadClick = () => fileInputRef.current?.click();
  
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Create a new element from uploaded file
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const newElement: CanvasElement = {
          id: `img-${Date.now()}`,
          type: 'image',
          src: event.target?.result as string, // Base64 for local preview
          x: 100,
          y: 100,
          width: Math.min(img.width, 600),
          height: Math.min(img.height, 600),
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          locked: false,
          name: file.name,
        };
        setElements(prev => [...prev, newElement]);
        toast.success(`Added ${file.name} to canvas`);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Debug info
  const debugInfo = {
    isMounted,
    hasContent: !!content,
    contentLength: content?.length || 0,
    hasCanvasData: !!canvasData,
    elementCount: elements.length,
    sandboxId: sandboxId || 'none',
    filePath: filePath || 'none',
  };

  if (!isMounted) {
    return (
      <div className="flex items-center justify-center h-full w-full" style={{ backgroundColor: '#1a1a1a' }}>
        <Loader2 className="h-8 w-8 animate-spin text-white/50" />
      </div>
    );
  }

  if (!content) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-4" style={{ backgroundColor: '#1a1a1a' }}>
        <AlertCircle className="h-12 w-12 text-yellow-400" />
        <div className="text-white/70 text-center">
          <p className="font-medium">No canvas content</p>
          <p className="text-sm text-white/50 mt-2">File: {filePath || 'unknown'}</p>
          <p className="text-sm text-white/50">Sandbox: {sandboxId || 'none'}</p>
          <p className="text-xs text-white/30 mt-4">Check browser console for errors</p>
        </div>
      </div>
    );
  }

  // Show error if canvas data failed to parse
  if (!canvasData && content) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-4" style={{ backgroundColor: '#1a1a1a' }}>
        <AlertCircle className="h-12 w-12 text-red-400" />
        <div className="text-white/70 text-center">
          <p className="font-medium">Failed to parse canvas</p>
          <p className="text-sm text-white/50 mt-1">Content preview: {content.substring(0, 100)}...</p>
        </div>
      </div>
    );
  }

  const backgroundColor = canvasData?.background || '#1a1a1a';

  return (
    <div className={cn("flex flex-col h-full w-full", className)} style={{ backgroundColor: '#0f0f0f', minHeight: '100%' }}>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={0}>
            {/* Select/Pan group */}
            <div className="flex items-center border border-border rounded-full px-1 py-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className={cn("h-7 w-7 rounded-full", toolMode === 'select' && "bg-primary text-primary-foreground")}
                    onClick={() => setToolMode('select')}
                  >
                    <MousePointer2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Select (V)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className={cn("h-7 w-7 rounded-full", toolMode === 'pan' && "bg-primary text-primary-foreground")}
                    onClick={() => setToolMode('pan')}
                  >
                    <Hand className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Pan (H)</TooltipContent>
              </Tooltip>
            </div>

            {/* Zoom group */}
            <div className="flex items-center border border-border rounded-full px-1 py-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={handleZoomOut}>
                    <Minus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Zoom Out</TooltipContent>
              </Tooltip>

              <span className="text-xs text-muted-foreground px-2 min-w-[3rem] text-center">
                {Math.round(scale * 100)}%
              </span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" onClick={handleZoomIn}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Zoom In</TooltipContent>
              </Tooltip>
            </div>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleResetView}>
                  <Maximize className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset View</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleSave}>
                  <Save className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Save Canvas</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleUploadClick}>
                  <ImagePlus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add Image</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Canvas name */}
        <div className="text-sm text-muted-foreground">
          {canvasData?.name || fileName?.replace('.kanvax', '')}
        </div>
      </div>

      {/* Canvas area */}
      <div 
        ref={containerRef} 
        className="flex-1 relative overflow-hidden"
        style={{ 
          backgroundColor,
          cursor: isPanning ? 'grabbing' : toolMode === 'pan' ? 'grab' : 'default',
        }}
        onMouseDown={handleCanvasMouseDown}
        onWheel={handleWheel}
      >
        {/* Grid pattern for infinite canvas feel */}
        <div
          className="absolute inset-0 pointer-events-none opacity-20"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
            `,
            backgroundSize: `${50 * scale}px ${50 * scale}px`,
            backgroundPosition: `${stagePosition.x}px ${stagePosition.y}px`,
          }}
        />

        {/* Empty state */}
        {elements.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-white/40">
              <ImagePlus className="h-16 w-16 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">Canvas is empty</p>
              <p className="text-sm mt-1">Add images to get started</p>
            </div>
          </div>
        )}

        {/* Render elements */}
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

        {/* Floating toolbar for selected element */}
        {selectedIds.length === 1 && (() => {
          const selected = elements.find(el => el.id === selectedIds[0]);
          if (!selected) return null;
          
          const toolbarX = selected.x * scale + stagePosition.x + (selected.width * scale) / 2;
          const toolbarY = selected.y * scale + stagePosition.y + selected.height * scale + 16;
          
          return (
            <TooltipProvider delayDuration={0}>
              <div
                style={{
                  position: 'absolute',
                  left: toolbarX,
                  top: toolbarY,
                  transform: 'translateX(-50%)',
                  zIndex: 100,
                }}
                className="flex items-center gap-1 bg-card border border-border rounded-lg px-2 py-1.5"
              >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      // Duplicate element
                      const newElement = {
                        ...selected,
                        id: `img-${Date.now()}`,
                        x: selected.x + 20,
                        y: selected.y + 20,
                      };
                      setElements(prev => [...prev, newElement]);
                      setSelectedIds([newElement.id]);
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Duplicate</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      handleElementChange(selected.id, { locked: !selected.locked });
                    }}
                  >
                    {selected.locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{selected.locked ? 'Unlock' : 'Lock'}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      // Move to front
                      setElements(prev => {
                        const idx = prev.findIndex(el => el.id === selected.id);
                        if (idx === -1 || idx === prev.length - 1) return prev;
                        const newArr = [...prev];
                        const [el] = newArr.splice(idx, 1);
                        newArr.push(el);
                        return newArr;
                      });
                    }}
                  >
                    <MoveUp className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Bring to Front</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      // Move to back
                      setElements(prev => {
                        const idx = prev.findIndex(el => el.id === selected.id);
                        if (idx <= 0) return prev;
                        const newArr = [...prev];
                        const [el] = newArr.splice(idx, 1);
                        newArr.unshift(el);
                        return newArr;
                      });
                    }}
                  >
                    <MoveDown className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Send to Back</TooltipContent>
              </Tooltip>

              <div className="w-px h-5 bg-border mx-1" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => {
                      setElements(prev => prev.filter(el => el.id !== selected.id));
                      setSelectedIds([]);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete</TooltipContent>
              </Tooltip>
              </div>
            </TooltipProvider>
          );
        })()}
      </div>
    </div>
  );
}
