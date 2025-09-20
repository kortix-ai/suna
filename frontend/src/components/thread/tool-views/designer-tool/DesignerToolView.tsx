import React, { useState, useRef, useEffect } from 'react';
import {
  Palette,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Download,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  Layers,
  Sparkles,
  Wand2,
  ExternalLink,
  Lock,
  Unlock,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { extractDesignerData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Toggle } from '@/components/ui/toggle';
import { useImageContent } from '@/hooks/react-query/files';

interface DesignElement {
  id: string;
  sandboxId: string;
  filePath: string;
  directUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  opacity: number;
  name: string;
  locked: boolean;
}

interface DesignerToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

function DesignElementImage({ 
  element,
  isSelected
}: { 
  element: DesignElement;
  isSelected: boolean;
}) {
  const [imageError, setImageError] = useState(false);
  
  // If we have a direct URL, use it; otherwise load via hook
  const { data: imageUrl, isLoading, error } = useImageContent(
    element.sandboxId,
    element.filePath,
    { 
      enabled: !element.directUrl && !imageError
    }
  );

  const finalUrl = element.directUrl || imageUrl;

  // Loading state
  if (!element.directUrl && isLoading && !finalUrl) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-muted/50 animate-pulse rounded-lg">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Error state
  if (!finalUrl || imageError || (!element.directUrl && error)) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full bg-muted/50 rounded-lg">
        <AlertTriangle className="h-8 w-8 text-muted-foreground mb-2" />
        <span className="text-xs text-muted-foreground text-center px-2">
          {element.name}
        </span>
      </div>
    );
  }

  return (
    <img
      src={finalUrl}
      alt={element.name}
      className="w-full h-full object-contain"
      style={{ borderRadius: 'inherit' }}
      draggable={false}
      onError={() => setImageError(true)}
      loading="eager"
    />
  );
}

export function DesignerToolView({
  name = 'designer_create_or_edit',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  onFileClick,
  project,
}: DesignerToolViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [elements, setElements] = useState<DesignElement[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [draggedElement, setDraggedElement] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [elementStart, setElementStart] = useState({ x: 0, y: 0 });
  const [canvasScale, setCanvasScale] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
  const [canvasOffsetStart, setCanvasOffsetStart] = useState({ x: 0, y: 0 });
  const gridSize = 20;
  const artboardPadding = 50;

  const {
    mode,
    prompt,
    designStyle,
    platformPreset,
    width,
    height,
    quality,
    imagePath,
    generatedImagePath,
    designUrl,
    status,
    error,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp,
    sandbox_id,
  } = extractDesignerData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  // Track processed paths to avoid duplicates
  const processedPathsRef = useRef<Set<string>>(new Set());
  const lastProcessedPath = useRef<string>('');

  useEffect(() => {
    if (generatedImagePath && !isStreaming) {
      const sandboxId = sandbox_id || project?.sandbox?.id || project?.id;
      
      if (!sandboxId) {
        console.warn('Designer Tool: No sandbox ID available');
        return;
      }
      
      let relativePath = generatedImagePath;
      if (relativePath.startsWith('/workspace/')) {
        relativePath = relativePath.substring('/workspace/'.length);
      } else if (relativePath.startsWith('/')) {
        relativePath = relativePath.substring(1);
      }
      
      // Create a unique key based on the actual content
      const contentKey = `${relativePath}-${designUrl || ''}-${JSON.stringify(toolContent)}`;
      
      // Skip if this is the exact same content we just processed
      if (lastProcessedPath.current === contentKey) {
        console.log('Designer Tool: Skipping duplicate content');
        return;
      }
      
      lastProcessedPath.current = contentKey;
      const elementId = `design-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      console.log('Designer Tool: Adding new element', {
        relativePath,
        designUrl,
        elementId,
        currentCount: elements.length
      });
      
      setElements(prevElements => {
        let x = 100;
        let y = 100;
        
        // Calculate position for new element
        if (prevElements.length > 0) {
          const rightmostElement = prevElements.reduce((rightmost, el) => {
            const rightmostRight = rightmost.x + rightmost.width;
            const currentRight = el.x + el.width;
            return currentRight > rightmostRight ? el : rightmost;
          }, prevElements[0]);
          
          x = rightmostElement.x + rightmostElement.width + artboardPadding;
          y = rightmostElement.y;
        }
        
        const newElement: DesignElement = {
          id: elementId,
          sandboxId: sandboxId,
          filePath: relativePath,
          directUrl: designUrl,
          x: x,
          y: y,
          width: width || 400,
          height: height || 400,
          rotation: 0,
          zIndex: prevElements.length,
          opacity: 100,
          name: relativePath.split('/').pop() || 'design',
          locked: false,
        };
        
        console.log('Designer Tool: New elements array', [...prevElements, newElement]);
        return [...prevElements, newElement];
      });
      
      setSelectedElement(elementId);
    }
  }, [generatedImagePath, designUrl, sandbox_id, project, width, height, isStreaming, toolContent]);

  const snapToGridValue = (value: number) => {
    if (!snapToGrid) return value;
    return Math.round(value / gridSize) * gridSize;
  };

  const handleElementMouseDown = (e: React.MouseEvent, elementId: string) => {
    e.stopPropagation();
    const element = elements.find(el => el.id === elementId);
    if (!element || element.locked) return;

    setSelectedElement(elementId);
    setDraggedElement(elementId);
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setElementStart({ x: element.x, y: element.y });
    e.preventDefault();
  };

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains('canvas-content')) {
      if (e.button === 0 || e.button === 1) {
        setIsPanning(true);
        setPanStart({ x: e.clientX, y: e.clientY });
        setCanvasOffsetStart({ ...canvasOffset });
        e.preventDefault();
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && draggedElement) {
      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;

      setElements(prevElements => {
        return prevElements.map(el => {
          if (el.id === draggedElement) {
            return {
              ...el,
              x: snapToGridValue(elementStart.x + deltaX / canvasScale),
              y: snapToGridValue(elementStart.y + deltaY / canvasScale),
            };
          }
          return el;
        });
      });
    } else if (isPanning) {
      const deltaX = e.clientX - panStart.x;
      const deltaY = e.clientY - panStart.y;

      setCanvasOffset({
        x: canvasOffsetStart.x + deltaX,
        y: canvasOffsetStart.y + deltaY,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    setDraggedElement(null);
    setIsPanning(false);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      setIsPanning(true);
      setPanStart({ x: touch.clientX, y: touch.clientY });
      setCanvasOffsetStart({ ...canvasOffset });
      e.preventDefault();
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isPanning && e.touches.length === 1) {
      const touch = e.touches[0];
      const deltaX = touch.clientX - panStart.x;
      const deltaY = touch.clientY - panStart.y;

      setCanvasOffset({
        x: canvasOffsetStart.x + deltaX,
        y: canvasOffsetStart.y + deltaY,
      });
    }
  };

  const handleTouchEnd = () => {
    setIsPanning(false);
  };

  const updateElement = (elementId: string, updates: Partial<DesignElement>) => {
    setElements(prevElements => {
      return prevElements.map(el => {
        if (el.id === elementId) {
          return { ...el, ...updates };
        }
        return el;
      });
    });
  };

  const handleZoomIn = () => {
    setCanvasScale(prev => Math.min(prev + 0.1, 2));
  };

  const handleZoomOut = () => {
    setCanvasScale(prev => Math.max(prev - 0.1, 0.5));
  };

  const handleResetView = () => {
    setCanvasScale(1);
    setCanvasOffset({ x: 0, y: 0 });
  };

  const handleDownload = () => {
    const element = elements.find(el => el.id === selectedElement);
    if (element?.directUrl || element?.filePath) {
      const link = document.createElement('a');
      link.href = element.directUrl || `/api/sandboxes/${element.sandboxId}/files?path=${encodeURIComponent(element.filePath)}`;
      link.download = element.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleOpenInNewTab = () => {
    const element = elements.find(el => el.id === selectedElement);
    if (element?.directUrl || element?.filePath) {
      const url = element.directUrl || `/api/sandboxes/${element.sandboxId}/files?path=${encodeURIComponent(element.filePath)}`;
      window.open(url, '_blank');
    }
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-16 border-b p-3 px-4">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/20">
              <Palette className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Designer Canvas
              </CardTitle>
              <div className="flex items-center gap-2 mt-1">
                {platformPreset && platformPreset !== 'custom' && (
                  <Badge variant="secondary" className="text-xs">
                    {platformPreset.replace(/_/g, ' ')}
                  </Badge>
                )}
                {designStyle && (
                  <Badge variant="outline" className="text-xs capitalize">
                    {designStyle}
                  </Badge>
                )}
                {width && height && (
                  <Badge variant="outline" className="text-xs">
                    {width}×{height}px
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <TooltipProvider>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 p-1 bg-background/80 rounded-lg border">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleZoomOut}
                        className="h-8 w-8"
                      >
                        <ZoomOut className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Zoom Out</TooltipContent>
                  </Tooltip>

                  <span className="text-xs px-2 min-w-[50px] text-center">
                    {Math.round(canvasScale * 100)}%
                  </span>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleZoomIn}
                        className="h-8 w-8"
                      >
                        <ZoomIn className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Zoom In</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleResetView}
                        className="h-8 w-8"
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Reset View</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <div className="flex items-center gap-1 bg-background/80 rounded-lg p-1 border">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Toggle
                      pressed={showGrid}
                      onPressedChange={setShowGrid}
                      className="h-8 w-8 data-[state=on]:bg-purple-100 dark:data-[state=on]:bg-purple-900/50"
                    >
                      <Grid className="h-4 w-4" />
                    </Toggle>
                  </TooltipTrigger>
                  <TooltipContent>Toggle Grid</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Toggle
                      pressed={snapToGrid}
                      onPressedChange={setSnapToGrid}
                      className="h-8 w-8 data-[state=on]:bg-purple-100 dark:data-[state=on]:bg-purple-900/50"
                    >
                      <svg
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="4" y="4" width="4" height="4" />
                        <rect x="10" y="10" width="4" height="4" />
                        <rect x="16" y="4" width="4" height="4" />
                        <rect x="4" y="16" width="4" height="4" />
                        <rect x="16" y="16" width="4" height="4" />
                      </svg>
                    </Toggle>
                  </TooltipTrigger>
                  <TooltipContent>Snap to Grid</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>

            {!isStreaming && (
              <Badge
                className={cn(
                  "px-3",
                  actualIsSuccess
                    ? "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white"
                    : "bg-gradient-to-r from-rose-500 to-rose-600 text-white"
                )}
              >
                {actualIsSuccess ? (
                  <CheckCircle className="h-3.5 w-3.5 mr-1" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                )}
                {actualIsSuccess ? 'Ready' : 'Failed'}
              </Badge>
            )}

            {isStreaming && (
              <Badge className="bg-gradient-to-r from-purple-500 to-purple-600 text-white">
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Creating Design
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 flex">
        <div className="flex flex-1">
          <div
            ref={canvasRef}
            className={cn(
              "flex-1 relative overflow-auto bg-zinc-50 dark:bg-zinc-950",
              isPanning && "cursor-grab"
            )}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {showGrid && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent ${gridSize - 1}px, rgba(0,0,0,0.05) ${gridSize}px),
                                    repeating-linear-gradient(90deg, transparent, transparent ${gridSize - 1}px, rgba(0,0,0,0.05) ${gridSize}px)`,
                  backgroundSize: `${gridSize}px ${gridSize}px`,
                }}
              />
            )}
            <div
              className="relative m-8 canvas-content"
              style={{
                transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${canvasScale})`,
                transformOrigin: 'top left',
                minWidth: '2400px',
                minHeight: '1600px',
              }}
            >
              {elements.map((element) => (
                <div
                  key={element.id}
                  className={cn(
                    "absolute cursor-move select-none rounded-lg",
                    element.locked && "cursor-not-allowed opacity-50"
                  )}
                  style={{
                    left: `${element.x}px`,
                    top: `${element.y}px`,
                    width: `${element.width}px`,
                    height: `${element.height}px`,
                    transform: `rotate(${element.rotation}deg)`,
                    zIndex: selectedElement === element.id ? 999 : element.zIndex,
                    opacity: element.opacity / 100,
                    boxSizing: 'border-box',
                    outline: selectedElement === element.id ? '2px solid rgb(168 85 247)' : 'none',
                    outlineOffset: '0px',
                  }}
                  onMouseDown={(e) => handleElementMouseDown(e, element.id)}
                  onClick={() => setSelectedElement(element.id)}
                >
                  <DesignElementImage
                    element={element}
                    isSelected={selectedElement === element.id}
                  />
                  {selectedElement === element.id && !element.locked && (
                    <>
                      <div className="absolute -top-3 -left-3 w-6 h-6 bg-white border-2 border-purple-500 rounded-full cursor-nw-resize z-10 shadow-sm" />
                      <div className="absolute -top-3 -right-3 w-6 h-6 bg-white border-2 border-purple-500 rounded-full cursor-ne-resize z-10 shadow-sm" />
                      <div className="absolute -bottom-3 -left-3 w-6 h-6 bg-white border-2 border-purple-500 rounded-full cursor-sw-resize z-10 shadow-sm" />
                      <div className="absolute -bottom-3 -right-3 w-6 h-6 bg-white border-2 border-purple-500 rounded-full cursor-se-resize z-10 shadow-sm" />
                    </>
                  )}
                </div>
              ))}
              {elements.length === 0 && !isStreaming && (
                <div className="flex flex-col items-center justify-center h-96 text-center">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900/50 dark:to-pink-900/50 flex items-center justify-center mb-4">
                    <Sparkles className="h-10 w-10 text-purple-600 dark:text-purple-400" />
                  </div>
                  <h3 className="text-lg font-medium text-foreground mb-2">
                    Professional Design Canvas
                  </h3>
                  <p className="text-sm text-muted-foreground max-w-md">
                    Your design will appear here. Drag to position, use controls to transform.
                  </p>
                </div>
              )}
              {isStreaming && (
                <div className="flex flex-col items-center justify-center h-96 text-center">
                  <Loader2 className="h-10 w-10 text-purple-600 dark:text-purple-400 animate-spin mb-4" />
                  <h3 className="text-lg font-medium text-foreground mb-2">
                    Generating Design
                  </h3>
                  <p className="text-sm text-muted-foreground max-w-md">
                    Creating your {platformPreset?.replace(/_/g, ' ')} design...
                  </p>
                </div>
              )}
            </div>
          </div>
          {selectedElement && elements.length > 0 && (() => {
            const element = elements.find(el => el.id === selectedElement);
            if (!element) return null;
            
            return (
              <div className="w-80 border-l bg-background p-4 space-y-4 overflow-y-auto">
                <div>
                  <h3 className="font-medium text-sm mb-3 flex items-center gap-2">
                    <Layers className="h-4 w-4" />
                    Artboard Properties
                  </h3>
                  
                  {elements.length > 1 && (
                    <div className="mb-4 space-y-2">
                      <label className="text-xs text-muted-foreground">Artboards ({elements.length})</label>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {elements.map((el, idx) => (
                          <div
                            key={el.id}
                            onClick={() => setSelectedElement(el.id)}
                            className={cn(
                              "p-2 rounded cursor-pointer text-xs flex items-center justify-between",
                              selectedElement === el.id 
                                ? "bg-purple-100 dark:bg-purple-900/50 border border-purple-500" 
                                : "hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent"
                            )}
                          >
                            <span className="truncate">
                              {idx + 1}. {el.name}
                            </span>
                            <Badge variant="outline" className="text-[10px] px-1 py-0">
                              {el.width}×{el.height}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Position</label>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs">X</label>
                          <input
                            type="number"
                            value={element.x}
                            onChange={e => updateElement(element.id, { x: Number(e.target.value) })}
                            className="w-full px-2 py-1 text-sm border rounded"
                          />
                        </div>
                        <div>
                          <label className="text-xs">Y</label>
                          <input
                            type="number"
                            value={element.y}
                            onChange={e => updateElement(element.id, { y: Number(e.target.value) })}
                            className="w-full px-2 py-1 text-sm border rounded"
                          />
                        </div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Size</label>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs">Width</label>
                          <input
                            type="number"
                            value={element.width}
                            onChange={e => updateElement(element.id, { width: Number(e.target.value) })}
                            className="w-full px-2 py-1 text-sm border rounded"
                          />
                        </div>
                        <div>
                          <label className="text-xs">Height</label>
                          <input
                            type="number"
                            value={element.height}
                            onChange={e => updateElement(element.id, { height: Number(e.target.value) })}
                            className="w-full px-2 py-1 text-sm border rounded"
                          />
                        </div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">
                        Rotation: {element.rotation}°
                      </label>
                      <Slider
                        value={[element.rotation]}
                        onValueChange={([value]) => updateElement(element.id, { rotation: value })}
                        min={-180}
                        max={180}
                        step={1}
                        className="w-full"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">
                        Opacity: {element.opacity}%
                      </label>
                      <Slider
                        value={[element.opacity]}
                        onValueChange={([value]) => updateElement(element.id, { opacity: value })}
                        min={0}
                        max={100}
                        step={1}
                        className="w-full"
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-muted-foreground">Lock Artboard</label>
                      <Toggle
                        pressed={element.locked}
                        onPressedChange={locked => updateElement(element.id, { locked })}
                        className="h-8"
                      >
                        {element.locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                      </Toggle>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={handleOpenInNewTab}
                      >
                        <ExternalLink className="h-4 w-4 mr-1" />
                        Open
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={handleDownload}
                      >
                        <Download className="h-4 w-4 mr-1" />
                        Export
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </CardContent>
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge className="h-6 py-0.5" variant="outline">
            <Wand2 className="h-3 w-3 mr-1" />
            Designer Canvas
          </Badge>
          {elements.length > 0 && (
            <Badge variant="secondary" className="h-6 py-0.5">
              {elements.length} Artboard{elements.length !== 1 ? 's' : ''}
            </Badge>
          )}
          {selectedElement && (() => {
            const element = elements.find(el => el.id === selectedElement);
            return element ? (
              <Badge variant="secondary" className="h-6 py-0.5">
                {element.name}
              </Badge>
            ) : null;
          })()}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {actualAssistantTimestamp ? formatTimestamp(actualAssistantTimestamp) : ''}
        </div>
      </div>
    </Card>
  );
}