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
    <div className={cn('flex flex-col w-full h-full', className)}>
      {/* Controls */}
      <div className="flex items-center justify-between py-2 px-4 bg-muted/30 border-b mb-2 rounded-t-md">
        <div className="flex items-center space-x-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleZoomOut}
            title="Zoom out"
            disabled={imgError}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-xs font-medium">{Math.round(zoom * 100)}%</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleZoomIn}
            title="Zoom in"
            disabled={imgError}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleRotate}
            title="Rotate"
            disabled={imgError}
          >
            <RotateCw className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center space-x-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setShowInfo(!showInfo)}
            title="Image information"
          >
            <Info className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
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
        </div>
      </div>

      {/* Image info overlay */}
      {showInfo && imgInfo && (
        <div className="absolute top-16 right-4 z-50 bg-background/80 backdrop-blur-sm p-3 rounded-md shadow-md border border-border text-xs">
          <p>
            <strong>Type:</strong> {imgInfo.type}
          </p>
          <p>
            <strong>Dimensions:</strong> {imgInfo.width} × {imgInfo.height}
          </p>
        </div>
      )}

      {/* Image container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative bg-grid-pattern rounded-b-md"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={{
          cursor: isPanning ? 'grabbing' : zoom > 0.5 ? 'grab' : 'default',
          backgroundColor: '#f5f5f5',
          backgroundImage:
            'linear-gradient(45deg, #e0e0e0 25%, transparent 25%), linear-gradient(-45deg, #e0e0e0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e0e0e0 75%), linear-gradient(-45deg, transparent 75%, #e0e0e0 75%)',
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
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
            className="absolute inset-0 flex items-center justify-center"
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
