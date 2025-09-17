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
  const { data: imageUrl, isLoading, error } = useImageContent(
    element.sandboxId,
    element.filePath
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-muted animate-pulse">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !imageUrl) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-muted">
        <AlertTriangle className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  return (
    <img
      src={imageUrl}
      alt={element.name}
      className="w-full h-full object-contain rounded-lg shadow-lg"
      draggable={false}
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
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [elementStart, setElementStart] = useState({ x: 0, y: 0 });
  const [canvasScale, setCanvasScale] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const gridSize = 20;
  const addedImagesRef = useRef<Set<string>>(new Set());

  const {
    mode,
    prompt,
    designStyle,
    width,
    height,
    quality,
    imagePath,
    generatedImagePath,
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

  useEffect(() => {
    if (generatedImagePath) {
      const sandboxId = sandbox_id || project?.sandbox?.id || project?.id;
      
      if (!sandboxId) {
        console.error('Designer Tool - No sandbox ID available');
        return;
      }
      
      let relativePath = generatedImagePath;
      if (relativePath.startsWith('/workspace/')) {
        relativePath = relativePath.substring('/workspace/'.length);
      } else if (relativePath.startsWith('/')) {
        relativePath = relativePath.substring(1);
      }
      
      // Create a unique key for this image
      const imageKey = `${sandboxId}:${relativePath}`;
      
      // Check if we've already added this image
      if (addedImagesRef.current.has(imageKey)) {
        console.log('Designer Tool - Image already added to canvas, skipping:', relativePath);
        return;
      }
      
      console.log('Designer Tool - Adding design element:', {
        originalPath: generatedImagePath,
        relativePath,
        sandboxId
      });

      addedImagesRef.current.add(imageKey);
      setElements(prev => {
        const exists = prev.some(el => el.filePath === relativePath && el.sandboxId === sandboxId);
        if (exists) {
          console.log('Designer Tool - Image already exists in state, skipping');
          return prev;
        }
        
        const newElement: DesignElement = {
          id: `design-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          sandboxId: sandboxId,
          filePath: relativePath,
          x: 100 + (prev.length * 20),
          y: 100 + (prev.length * 20),
          width: width || 400,
          height: height || 400,
          rotation: 0,
          zIndex: prev.length,
          opacity: 100,
          name: relativePath.split('/').pop() || 'design',
          locked: false,
        };
        
        setTimeout(() => setSelectedElement(newElement.id), 0);
        
        return [...prev, newElement];
      });
    }
  }, [generatedImagePath, sandbox_id, project, width, height]);

  const snapToGridValue = (value: number) => {
    if (!snapToGrid) return value;
    return Math.round(value / gridSize) * gridSize;
  };

  const handleMouseDown = (e: React.MouseEvent, elementId: string) => {
    const element = elements.find(el => el.id === elementId);
    if (!element || element.locked) return;

    setSelectedElement(elementId);
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setElementStart({ x: element.x, y: element.y });
    e.preventDefault();
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !selectedElement) return;

    const deltaX = e.clientX - dragStart.x;
    const deltaY = e.clientY - dragStart.y;

    setElements(prev =>
      prev.map(el => {
        if (el.id === selectedElement) {
          return {
            ...el,
            x: snapToGridValue(elementStart.x + deltaX / canvasScale),
            y: snapToGridValue(elementStart.y + deltaY / canvasScale),
          };
        }
        return el;
      })
    );
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const updateSelectedElement = (updates: Partial<DesignElement>) => {
    if (!selectedElement) return;

    setElements(prev =>
      prev.map(el => {
        if (el.id === selectedElement) {
          return { ...el, ...updates };
        }
        return el;
      })
    );
  };

  const handleZoomIn = () => {
    setCanvasScale(prev => Math.min(prev + 0.1, 2));
  };

  const handleZoomOut = () => {
    setCanvasScale(prev => Math.max(prev - 0.1, 0.5));
  };

  const handleResetView = () => {
    setCanvasScale(1);
  };

  const handleDownloadCanvas = () => {
    const selected = elements.find(el => el.id === selectedElement);
    if (selected && onFileClick) {
      onFileClick(selected.filePath);
    }
  };

  const bringToFront = () => {
    if (!selectedElement) return;
    const maxZ = Math.max(...elements.map(el => el.zIndex));
    updateSelectedElement({ zIndex: maxZ + 1 });
  };

  const sendToBack = () => {
    if (!selectedElement) return;
    updateSelectedElement({ zIndex: 0 });
    setElements(prev =>
      prev.map(el => {
        if (el.id !== selectedElement && el.zIndex >= 0) {
          return { ...el, zIndex: el.zIndex + 1 };
        }
        return el;
      })
    );
  };

  const selectedElementData = elements.find(el => el.id === selectedElement);

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
                Designer
              </CardTitle>
              <div className="flex items-center gap-2 mt-1">
                {designStyle && (
                  <Badge variant="secondary" className="text-xs">
                    {designStyle}
                  </Badge>
                )}
                {quality === 'hd' && (
                  <Badge variant="secondary" className="text-xs">
                    HD
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
            className="flex-1 relative overflow-auto bg-zinc-50 dark:bg-zinc-950"
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
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
              className="relative m-8"
              style={{
                transform: `scale(${canvasScale})`,
                transformOrigin: 'top left',
                minWidth: '1200px',
                minHeight: '800px',
              }}
            >
              {elements.map(element => (
                <div
                  key={element.id}
                  className={cn(
                    "absolute cursor-move select-none",
                    selectedElement === element.id && "ring-2 ring-purple-500 ring-offset-2",
                    element.locked && "cursor-not-allowed opacity-50"
                  )}
                  style={{
                    left: `${element.x}px`,
                    top: `${element.y}px`,
                    width: `${element.width}px`,
                    height: `${element.height}px`,
                    transform: `rotate(${element.rotation}deg)`,
                    zIndex: element.zIndex,
                    opacity: element.opacity / 100,
                  }}
                  onMouseDown={e => handleMouseDown(e, element.id)}
                  onClick={() => setSelectedElement(element.id)}
                >
                  <DesignElementImage
                    element={element}
                    isSelected={selectedElement === element.id}
                  />
                  {selectedElement === element.id && !element.locked && (
                    <>
                      <div className="absolute -top-2 -left-2 w-4 h-4 bg-white border-2 border-purple-500 rounded-full cursor-nw-resize" />
                      <div className="absolute -top-2 -right-2 w-4 h-4 bg-white border-2 border-purple-500 rounded-full cursor-ne-resize" />
                      <div className="absolute -bottom-2 -left-2 w-4 h-4 bg-white border-2 border-purple-500 rounded-full cursor-sw-resize" />
                      <div className="absolute -bottom-2 -right-2 w-4 h-4 bg-white border-2 border-purple-500 rounded-full cursor-se-resize" />
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
                    Your designs will appear here. Drag to position, use controls to transform.
                  </p>
                </div>
              )}
            </div>
          </div>
          {selectedElementData && (
            <div className="w-80 border-l bg-background p-4 space-y-4 overflow-y-auto">
              <div>
                <h3 className="font-medium text-sm mb-3 flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  Element Properties
                </h3>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">Position</label>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs">X</label>
                        <input
                          type="number"
                          value={selectedElementData.x}
                          onChange={e => updateSelectedElement({ x: Number(e.target.value) })}
                          className="w-full px-2 py-1 text-sm border rounded"
                        />
                      </div>
                      <div>
                        <label className="text-xs">Y</label>
                        <input
                          type="number"
                          value={selectedElementData.y}
                          onChange={e => updateSelectedElement({ y: Number(e.target.value) })}
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
                          value={selectedElementData.width}
                          onChange={e => updateSelectedElement({ width: Number(e.target.value) })}
                          className="w-full px-2 py-1 text-sm border rounded"
                        />
                      </div>
                      <div>
                        <label className="text-xs">Height</label>
                        <input
                          type="number"
                          value={selectedElementData.height}
                          onChange={e => updateSelectedElement({ height: Number(e.target.value) })}
                          className="w-full px-2 py-1 text-sm border rounded"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">
                      Rotation: {selectedElementData.rotation}°
                    </label>
                    <Slider
                      value={[selectedElementData.rotation]}
                      onValueChange={([value]) => updateSelectedElement({ rotation: value })}
                      min={-180}
                      max={180}
                      step={1}
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">
                      Opacity: {selectedElementData.opacity}%
                    </label>
                    <Slider
                      value={[selectedElementData.opacity]}
                      onValueChange={([value]) => updateSelectedElement({ opacity: value })}
                      min={0}
                      max={100}
                      step={1}
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">Layer Order</label>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={bringToFront}
                        className="flex-1"
                      >
                        Bring to Front
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={sendToBack}
                        className="flex-1"
                      >
                        Send to Back
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-muted-foreground">Lock Element</label>
                    <Toggle
                      pressed={selectedElementData.locked}
                      onPressedChange={locked => updateSelectedElement({ locked })}
                      className="h-8"
                    >
                      {selectedElementData.locked ? '🔒' : '🔓'}
                    </Toggle>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleDownloadCanvas}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Export Design
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </CardContent>
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge className="h-6 py-0.5" variant="outline">
            <Wand2 className="h-3 w-3 mr-1" />
            Designer Tool
          </Badge>
          {elements.length > 0 && (
            <Badge variant="secondary" className="h-6 py-0.5">
              {elements.length} element{elements.length !== 1 ? 's' : ''}
            </Badge>
          )}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {actualAssistantTimestamp ? formatTimestamp(actualAssistantTimestamp) : ''}
        </div>
      </div>
    </Card>
  );
} 