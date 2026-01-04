'use client';

import React, { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize2,
  Minimize2,
  Info,
} from 'lucide-react';

interface ImageRendererProps {
  url: string;
  className?: string;
}

export function ImageRenderer({ url, className }: ImageRendererProps) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [startPanPosition, setStartPanPosition] = useState({ x: 0, y: 0 });
  const [isFitToScreen, setIsFitToScreen] = useState(true);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [imgInfo, setImgInfo] = useState<{
    width: number;
    height: number;
    type: string;
  } | null>(null);
  const [showControls, setShowControls] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Check if the url is an SVG
  const isSvg =
    url?.toLowerCase().endsWith('.svg') || url?.includes('image/svg');

  // Reset position when zoom changes
  useEffect(() => {
    if (isFitToScreen) {
      setPosition({ x: 0, y: 0 });
    }
  }, [zoom, isFitToScreen]);

  // Handle image load success
  const handleImageLoad = () => {
    setImgLoaded(true);
    setImgError(false);

    if (imageRef.current) {
      setImgInfo({
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight,
        type: isSvg ? 'SVG' : url.split('.').pop()?.toUpperCase() || 'Image',
      });
    }
  };

  // Handle image load error
  const handleImageError = () => {
    setImgLoaded(false);
    setImgError(true);
  };

  // Functions for zooming
  const handleZoomIn = () => {
    setZoom((prev) => Math.min(prev + 0.25, 3));
    setIsFitToScreen(false);
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(zoom - 0.25, 0.5);
    setZoom(newZoom);
    if (newZoom === 0.5) {
      setIsFitToScreen(true);
    }
  };

  // Function for rotation
  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  // Toggle fit to screen
  const toggleFitToScreen = () => {
    if (isFitToScreen) {
      setZoom(1);
      setIsFitToScreen(false);
    } else {
      setZoom(0.5);
      setPosition({ x: 0, y: 0 });
      setIsFitToScreen(true);
    }
  };

  // Pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom > 0.5) {
      setIsPanning(true);
      setStartPanPosition({
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning && zoom > 0.5) {
      setPosition({
        x: e.clientX - startPanPosition.x,
        y: e.clientY - startPanPosition.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const handleMouseLeave = () => {
    setIsPanning(false);
  };

  // Calculate transform styles
  const imageTransform = `scale(${zoom}) rotate(${rotation}deg)`;
  const translateTransform = `translate(${position.x}px, ${position.y}px)`;

  // Show image info
  const [showInfo, setShowInfo] = useState(false);

  return (
    <div 
      className={cn('relative w-full h-full group', className)}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
    >
      {/* Floating Controls - Only visible on hover */}
      <div 
        className={cn(
          "absolute top-4 left-1/2 -translate-x-1/2 z-10 transition-all duration-200",
          showControls || showInfo ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2 pointer-events-none"
        )}
      >
        <div className="flex items-center gap-1 bg-card border border-border rounded-xl px-2 py-1.5 shadow-lg">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 hover:bg-muted"
            onClick={handleZoomOut}
            title="Zoom out"
            disabled={imgError}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-xs font-medium px-2 min-w-[48px] text-center text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 hover:bg-muted"
            onClick={handleZoomIn}
            title="Zoom in"
            disabled={imgError}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          
          <div className="w-px h-4 bg-border mx-1" />
          
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 hover:bg-muted"
            onClick={handleRotate}
            title="Rotate"
            disabled={imgError}
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 hover:bg-muted"
            onClick={toggleFitToScreen}
            title={isFitToScreen ? 'Actual size' : 'Fit to screen'}
            disabled={imgError}
          >
            {isFitToScreen ? (
              <Maximize2 className="h-4 w-4" />
            ) : (
              <Minimize2 className="h-4 w-4" />
            )}
          </Button>
          
          <div className="w-px h-4 bg-border mx-1" />
          
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 hover:bg-muted"
            onClick={() => setShowInfo(!showInfo)}
            title="Image information"
          >
            <Info className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Image info overlay */}
      {showInfo && imgInfo && (
        <div className="absolute top-16 right-4 z-10 bg-card p-4 rounded-xl shadow-lg border border-border text-sm min-w-[180px]">
          <div className="space-y-2">
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">Type</span>
              <span className="font-medium">{imgInfo.type}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">Size</span>
              <span className="font-medium">{imgInfo.width} × {imgInfo.height}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">Zoom</span>
              <span className="font-medium">{Math.round(zoom * 100)}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Image container - Clean background */}
      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden relative bg-background"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{
          cursor: isPanning ? 'grabbing' : zoom > 0.5 ? 'grab' : 'default',
        }}
      >
        {imgError ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center">
            <p className="text-destructive font-medium mb-2">
              Failed to load image
            </p>
            <p className="text-sm text-muted-foreground">
              The image could not be displayed
            </p>
          </div>
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center p-8"
            style={{
              transform: isFitToScreen ? 'none' : translateTransform,
              transition: isPanning ? 'none' : 'transform 0.1s ease',
            }}
          >
            {isSvg ? (
              // Special handling for SVG - embed it as an object for better rendering
              <object
                data={url}
                type="image/svg+xml"
                className="max-w-full max-h-full"
                style={{
                  transform: imageTransform,
                  transition: 'transform 0.2s ease',
                  width: '100%',
                  height: '100%',
                }}
              >
                {/* Fallback to img if object fails */}
                <img
                  ref={imageRef}
                  src={url}
                  alt="SVG preview"
                  className="max-w-full max-h-full object-contain"
                  style={{
                    transform: imageTransform,
                    transition: 'transform 0.2s ease',
                  }}
                  draggable={false}
                  onLoad={handleImageLoad}
                  onError={handleImageError}
                />
              </object>
            ) : (
              <img
                ref={imageRef}
                src={url}
                alt="Image preview"
                className="max-w-full max-h-full object-contain"
                style={{
                  transform: imageTransform,
                  transition: 'transform 0.2s ease',
                  boxShadow: imgLoaded ? '0 8px 32px -4px rgba(0, 0, 0, 0.15)' : 'none',
                }}
                draggable={false}
                onLoad={handleImageLoad}
                onError={handleImageError}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
