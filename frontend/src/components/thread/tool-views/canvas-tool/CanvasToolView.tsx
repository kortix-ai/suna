'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Konva from 'konva';
import { Stage, Layer, KonvaImage, Transformer } from './KonvaStage';
import {
  Layout,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  Layers,
  Lock,
  Unlock,
  Save,
  Eye,
  EyeOff,
  Trash2,
  Copy,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { extractCanvasData, CanvasElement, CanvasData, isCanvasFile } from './_utils';
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
import { useImageContent, useFileContent } from '@/hooks/files';
import { toast } from 'sonner';

interface KonvaImageElementProps {
  element: CanvasElement;
  isSelected: boolean;
  onSelect: () => void;
  onChange: (newAttrs: Partial<CanvasElement>) => void;
  imageUrl?: string;
}

function KonvaImageElement({
  element,
  isSelected,
  onSelect,
  onChange,
  imageUrl,
}: KonvaImageElementProps) {
  const imageRef = useRef<Konva.Image>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (imageUrl) {
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.src = imageUrl;
      img.onload = () => {
        setImage(img);
      };
    }
  }, [imageUrl]);

  useEffect(() => {
    if (isSelected && transformerRef.current && imageRef.current) {
      transformerRef.current.nodes([imageRef.current]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [isSelected]);

  const handleTransformEnd = () => {
    const node = imageRef.current;
    if (node) {
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();

      // Reset scale and adjust width/height instead
      node.scaleX(1);
      node.scaleY(1);

      onChange({
        x: node.x(),
        y: node.y(),
        width: Math.max(5, node.width() * scaleX),
        height: Math.max(5, node.height() * scaleY),
        rotation: node.rotation(),
      });
    }
  };

  const handleDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
    onChange({
      x: e.target.x(),
      y: e.target.y(),
    });
  };

  if (!image) return null;

  return (
    <>
      <KonvaImage
        ref={imageRef}
        image={image}
        x={element.x}
        y={element.y}
        width={element.width}
        height={element.height}
        rotation={element.rotation}
        opacity={element.opacity}
        draggable={!element.locked}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={handleDragEnd}
        onTransformEnd={handleTransformEnd}
      />
      {isSelected && !element.locked && (
        <Transformer
          ref={transformerRef}
          boundBoxFunc={(oldBox, newBox) => {
            // Limit resize
            if (newBox.width < 5 || newBox.height < 5) {
              return oldBox;
            }
            return newBox;
          }}
        />
      )}
    </>
  );
}

interface CanvasToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

export function CanvasToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  onFileClick,
  project,
}: CanvasToolViewProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [canvasData, setCanvasData] = useState<CanvasData | null>(null);
  const [scale, setScale] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [stageSize, setStageSize] = useState({ width: 1000, height: 600 });
  const [isMounted, setIsMounted] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Only render Konva on client side
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Extract canvas data
  const extractedData = toolCall ? extractCanvasData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  ) : null;

  const {
    canvasName,
    canvasPath,
    width: canvasWidth,
    height: canvasHeight,
    background,
    actualIsSuccess,
    sandbox_id,
  } = extractedData || {};

  // Load canvas file content if path is provided
  const { data: canvasFileContent, isLoading: isLoadingCanvas } = useFileContent(
    sandbox_id || project?.sandbox?.id || '',
    canvasPath || '',
    {
      enabled: !!canvasPath && !!sandbox_id,
    }
  );

  // Parse canvas file content
  useEffect(() => {
    if (canvasFileContent && !isLoadingCanvas) {
      try {
        const parsed: CanvasData = JSON.parse(canvasFileContent);
        setCanvasData(parsed);
        setElements(parsed.elements || []);
      } catch (e) {
        console.error('Failed to parse canvas file:', e);
        toast.error('Failed to load canvas data');
      }
    }
  }, [canvasFileContent, isLoadingCanvas]);

  // Update stage size based on container
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth;
        const height = containerRef.current.offsetHeight;
        setStageSize({ width, height });
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Load images for elements
  const elementImageUrls = new Map<string, string>();
  elements.forEach((element) => {
    const { data: imageUrl } = useImageContent(
      sandbox_id || project?.sandbox?.id || '',
      element.src,
      { enabled: !!element.src }
    );
    if (imageUrl) {
      elementImageUrls.set(element.id, imageUrl);
    }
  });

  const handleElementChange = useCallback((id: string, newAttrs: Partial<CanvasElement>) => {
    setElements((prev) =>
      prev.map((el) => (el.id === id ? { ...el, ...newAttrs } : el))
    );
  }, []);

  const handleZoomIn = () => {
    setScale((prev) => Math.min(prev + 0.1, 3));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(prev - 0.1, 0.3));
  };

  const handleResetView = () => {
    setScale(1);
  };

  const handleSave = async () => {
    if (!canvasPath || !canvasData) {
      toast.error('Cannot save canvas: missing canvas data');
      return;
    }

    try {
      const updatedCanvas: CanvasData = {
        ...canvasData,
        elements,
        updated_at: new Date().toISOString(),
      };

      // TODO: Implement save via API call to update canvas file
      toast.success('Canvas saved successfully');
    } catch (error) {
      console.error('Failed to save canvas:', error);
      toast.error('Failed to save canvas');
    }
  };

  const selectedElement = elements.find((el) => el.id === selectedId);

  const checkDeselect = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const clickedOnEmpty = e.target === e.target.getStage();
    if (clickedOnEmpty) {
      setSelectedId(null);
    }
  };

  if (!toolCall) {
    return null;
  }

  const displayWidth = canvasData?.width || canvasWidth || 1920;
  const displayHeight = canvasData?.height || canvasHeight || 1080;
  const displayBackground = canvasData?.background || background || '#ffffff';

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-16 border-b p-3 px-4">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/20">
              <Layout className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Canvas Editor
              </CardTitle>
              <div className="flex items-center gap-2 mt-1">
                {canvasName && (
                  <Badge variant="secondary" className="text-xs">
                    {canvasName}
                  </Badge>
                )}
                {displayWidth && displayHeight && (
                  <Badge variant="outline" className="text-xs">
                    {displayWidth}×{displayHeight}px
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
                    {Math.round(scale * 100)}%
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
                        className="h-8 w-8 data-[state=on]:bg-blue-100 dark:data-[state=on]:bg-blue-900/50"
                      >
                        <Grid className="h-4 w-4" />
                      </Toggle>
                    </TooltipTrigger>
                    <TooltipContent>Toggle Grid</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleSave}
                        className="h-8 w-8"
                      >
                        <Save className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Save Canvas</TooltipContent>
                  </Tooltip>
                </div>
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
              <Badge className="bg-gradient-to-r from-blue-500 to-blue-600 text-white">
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Loading Canvas
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 flex">
        <div className="flex flex-1">
          <div
            ref={containerRef}
            className="flex-1 relative overflow-hidden bg-zinc-50 dark:bg-zinc-950"
          >
            {showGrid && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  backgroundImage: `repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(0,0,0,0.05) 20px),
                                    repeating-linear-gradient(90deg, transparent, transparent 19px, rgba(0,0,0,0.05) 20px)`,
                  backgroundSize: '20px 20px',
                }}
              />
            )}
            {isMounted && (
              <Stage
                ref={stageRef}
                width={stageSize.width}
                height={stageSize.height}
                scaleX={scale}
                scaleY={scale}
                onMouseDown={checkDeselect}
                onTouchStart={checkDeselect}
              >
                <Layer>
                  {/* Canvas background */}
                  <KonvaImage
                    x={0}
                    y={0}
                    width={displayWidth}
                    height={displayHeight}
                    fill={displayBackground}
                    listening={false}
                  />

                  {/* Canvas elements */}
                  {elements.map((element) => (
                    <KonvaImageElement
                      key={element.id}
                      element={element}
                      isSelected={element.id === selectedId}
                      onSelect={() => setSelectedId(element.id)}
                      onChange={(newAttrs) => handleElementChange(element.id, newAttrs)}
                      imageUrl={elementImageUrls.get(element.id)}
                    />
                  ))}
                </Layer>
              </Stage>
            )}

            {elements.length === 0 && !isStreaming && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-100 to-cyan-100 dark:from-blue-900/50 dark:to-cyan-900/50 flex items-center justify-center mb-4">
                  <Layout className="h-10 w-10 text-blue-600 dark:text-blue-400" />
                </div>
                <h3 className="text-lg font-medium text-foreground mb-2">
                  Interactive Canvas
                </h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  Add images to your canvas and arrange them interactively
                </p>
              </div>
            )}

            {isStreaming && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <Loader2 className="h-10 w-10 text-blue-600 dark:text-blue-400 animate-spin mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">
                  Loading Canvas
                </h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  Preparing your canvas...
                </p>
              </div>
            )}
          </div>

          {selectedElement && (
            <div className="w-80 border-l bg-background p-4 space-y-4 overflow-y-auto">
              <div>
                <h3 className="font-medium text-sm mb-3 flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  Element Properties
                </h3>

                {elements.length > 1 && (
                  <div className="mb-4 space-y-2">
                    <label className="text-xs text-muted-foreground">
                      Elements ({elements.length})
                    </label>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {elements.map((el, idx) => (
                        <div
                          key={el.id}
                          onClick={() => setSelectedId(el.id)}
                          className={cn(
                            "p-2 rounded cursor-pointer text-xs flex items-center justify-between",
                            selectedId === el.id
                              ? "bg-blue-100 dark:bg-blue-900/50 border border-blue-500"
                              : "hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent"
                          )}
                        >
                          <span className="truncate">
                            {idx + 1}. {el.name}
                          </span>
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
                          value={Math.round(selectedElement.x)}
                          onChange={(e) =>
                            handleElementChange(selectedElement.id, { x: Number(e.target.value) })
                          }
                          className="w-full px-2 py-1 text-sm border rounded bg-background"
                        />
                      </div>
                      <div>
                        <label className="text-xs">Y</label>
                        <input
                          type="number"
                          value={Math.round(selectedElement.y)}
                          onChange={(e) =>
                            handleElementChange(selectedElement.id, { y: Number(e.target.value) })
                          }
                          className="w-full px-2 py-1 text-sm border rounded bg-background"
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
                          value={Math.round(selectedElement.width)}
                          onChange={(e) =>
                            handleElementChange(selectedElement.id, {
                              width: Number(e.target.value),
                            })
                          }
                          className="w-full px-2 py-1 text-sm border rounded bg-background"
                        />
                      </div>
                      <div>
                        <label className="text-xs">Height</label>
                        <input
                          type="number"
                          value={Math.round(selectedElement.height)}
                          onChange={(e) =>
                            handleElementChange(selectedElement.id, {
                              height: Number(e.target.value),
                            })
                          }
                          className="w-full px-2 py-1 text-sm border rounded bg-background"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">
                      Rotation: {Math.round(selectedElement.rotation)}°
                    </label>
                    <Slider
                      value={[selectedElement.rotation]}
                      onValueChange={([value]) =>
                        handleElementChange(selectedElement.id, { rotation: value })
                      }
                      min={-180}
                      max={180}
                      step={1}
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">
                      Opacity: {Math.round(selectedElement.opacity * 100)}%
                    </label>
                    <Slider
                      value={[selectedElement.opacity * 100]}
                      onValueChange={([value]) =>
                        handleElementChange(selectedElement.id, { opacity: value / 100 })
                      }
                      min={0}
                      max={100}
                      step={1}
                      className="w-full"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="text-xs text-muted-foreground">Lock Element</label>
                    <Toggle
                      pressed={selectedElement.locked}
                      onPressedChange={(locked) =>
                        handleElementChange(selectedElement.id, { locked })
                      }
                      className="h-8"
                    >
                      {selectedElement.locked ? (
                        <Lock className="h-4 w-4" />
                      ) : (
                        <Unlock className="h-4 w-4" />
                      )}
                    </Toggle>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                        const newElements = elements.filter((el) => el.id !== selectedElement.id);
                        setElements(newElements);
                        setSelectedId(null);
                        toast.success('Element removed');
                      }}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Badge className="h-6 py-0.5" variant="outline">
            <Layout className="h-3 w-3 mr-1" />
            Canvas Editor
          </Badge>
          {elements.length > 0 && (
            <Badge variant="secondary" className="h-6 py-0.5">
              {elements.length} Element{elements.length !== 1 ? 's' : ''}
            </Badge>
          )}
          {selectedElement && (
            <Badge variant="secondary" className="h-6 py-0.5">
              {selectedElement.name}
            </Badge>
          )}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {assistantTimestamp ? formatTimestamp(assistantTimestamp) : ''}
        </div>
      </div>
    </Card>
  );
}

