'use client';

import { CODE_SETTLE_MS, useSettledValue } from '../lib/settle';
import { Button } from './button';
import { ButtonGroup } from './button-group';
import Hint from './hint';
import { KortixLoader } from './kortix-loader';
import { renderMermaidSvg, zoomAtPoint } from './mermaid-render';
import { Modal, ModalBody, ModalClose, ModalContent, ModalTitle } from './modal';
import { cn } from '../lib/utils';
import {
  CheckIcon as Check,
  ArrowsOutSimpleIcon as Maximize2,
  ArrowCounterClockwiseIcon as RotateCcw,
  XIcon as X,
  MagnifyingGlassPlusIcon as ZoomIn,
  MagnifyingGlassMinusIcon as ZoomOut,
} from '@phosphor-icons/react';
import { Copy } from '../icons/copy';
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface MermaidRendererProps {
  chart: string;
  className?: string;
  enableFullscreen?: boolean;
  /**
   * The message is still streaming. The diagram renders once its source holds
   * still for `CODE_SETTLE_MS`, not once per streamed token.
   */
  isStreaming?: boolean;
  /** Extra controls beside copy and fullscreen, shown on hover (e.g. "Edit diagram"). */
  actions?: React.ReactNode;
}

export const MermaidRenderer: React.FC<MermaidRendererProps> = React.memo(
  ({ chart, className, enableFullscreen = true, isStreaming = false, actions }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [renderedContent, setRenderedContent] = useState<string>('');
    const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);

    // The source to render: null while a streaming diagram is still changing.
    const source = useSettledValue(chart.trim(), isStreaming, CODE_SETTLE_MS);

    // Canvas state for fullscreen viewer
    const canvasRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [lastTouchDistance, setLastTouchDistance] = useState<number | null>(null);

    // Inline-card control: copy the diagram source.
    const [copied, setCopied] = useState(false);

    const handleCopySource = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(chart);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy diagram source:', err);
      }
    }, [chart]);

    const handleRotate = useCallback(() => setRotation((prev) => prev + 90), []);

    // Canvas event handlers
    const handleMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (e.button === 0) {
          // Left mouse button
          setIsDragging(true);
          setDragStart({
            x: e.clientX - panOffset.x,
            y: e.clientY - panOffset.y,
          });
        }
      },
      [panOffset],
    );

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        if (isDragging) {
          const newOffset = {
            x: e.clientX - dragStart.x,
            y: e.clientY - dragStart.y,
          };
          setPanOffset(newOffset);
        }
      },
      [isDragging, dragStart],
    );

    const handleMouseUp = useCallback(() => {
      setIsDragging(false);
    }, []);

    // Touch event handlers for mobile support
    const getTouchDistance = (touches: React.TouchList) => {
      if (touches.length < 2) return null;
      const touch1 = touches[0];
      const touch2 = touches[1];
      return Math.sqrt(
        Math.pow(touch2.clientX - touch1.clientX, 2) + Math.pow(touch2.clientY - touch1.clientY, 2),
      );
    };

    const getTouchCenter = (touches: React.TouchList) => {
      if (touches.length === 0) return { x: 0, y: 0 };
      if (touches.length === 1) return { x: touches[0].clientX, y: touches[0].clientY };

      const touch1 = touches[0];
      const touch2 = touches[1];
      return {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };
    };

    const handleTouchStart = useCallback(
      (e: React.TouchEvent) => {
        if (e.touches.length === 1) {
          // Single touch - start panning
          setIsDragging(true);
          setDragStart({
            x: e.touches[0].clientX - panOffset.x,
            y: e.touches[0].clientY - panOffset.y,
          });
        } else if (e.touches.length === 2) {
          // Two touches - start pinch zoom
          setIsDragging(false);
          setLastTouchDistance(getTouchDistance(e.touches));
        }
      },
      [panOffset],
    );

    const applyCanvasZoom = useCallback(
      (point: { x: number; y: number }, zoomFactor: number) => {
        if (canvasRef.current) {
          const rect = canvasRef.current.getBoundingClientRect();
          const mouseX = point.x - rect.left;
          const mouseY = point.y - rect.top;

          const next = zoomAtPoint(zoom, panOffset, { x: mouseX, y: mouseY }, zoomFactor);
          setZoom(next.zoom);
          setPanOffset(next.panOffset);
        }
      },
      [zoom, panOffset],
    );

    const handleTouchMove = useCallback(
      (e: React.TouchEvent) => {
        // Only prevent default if we're actively interacting with the canvas
        if (isDragging || (e.touches.length === 2 && lastTouchDistance)) {
          e.preventDefault();
        }

        if (e.touches.length === 1 && isDragging) {
          // Single touch - pan
          const newOffset = {
            x: e.touches[0].clientX - dragStart.x,
            y: e.touches[0].clientY - dragStart.y,
          };
          setPanOffset(newOffset);
        } else if (e.touches.length === 2 && lastTouchDistance) {
          // Two touches - pinch zoom
          e.preventDefault(); // Always prevent default for pinch zoom
          const currentDistance = getTouchDistance(e.touches);
          if (currentDistance) {
            const zoomFactor = currentDistance / lastTouchDistance;

            // Zoom towards touch center
            applyCanvasZoom(getTouchCenter(e.touches), zoomFactor);

            setLastTouchDistance(currentDistance);
          }
        }
      },
      [isDragging, dragStart, lastTouchDistance, applyCanvasZoom],
    );

    const handleTouchEnd = useCallback(() => {
      setIsDragging(false);
      setLastTouchDistance(null);
    }, []);

    // Wheel event handler - attached manually to avoid passive event issues
    const handleWheelEvent = useCallback(
      (e: WheelEvent) => {
        // Only handle zoom if Ctrl/Cmd is held or we're over the canvas
        if (!canvasRef.current?.contains(e.target as Node)) return;

        e.preventDefault();
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

        // Zoom towards mouse position
        applyCanvasZoom({ x: e.clientX, y: e.clientY }, zoomFactor);
      },
      [applyCanvasZoom],
    );

    // Attach wheel event listener manually with passive: false
    useEffect(() => {
      const canvasElement = canvasRef.current;
      if (canvasElement && isFullscreenOpen) {
        canvasElement.addEventListener('wheel', handleWheelEvent, {
          passive: false,
        });
        return () => {
          canvasElement.removeEventListener('wheel', handleWheelEvent);
        };
      }
    }, [isFullscreenOpen, handleWheelEvent]);

    // Simple zoom controls
    const handleZoomIn = () => setZoom((prev) => Math.min(5, prev * 1.2));
    const handleZoomOut = () => setZoom((prev) => Math.max(0.1, prev * 0.8));

    const handleFullscreenOpen = () => {
      if (enableFullscreen) {
        setIsFullscreenOpen(true);
        // Reset canvas state
        setZoom(0.8); // Start with a reasonable fit
        setRotation(0);
        setPanOffset({ x: 0, y: 0 });
        setIsDragging(false);
      }
    };

    useEffect(() => {
      if (source === null) return;
      let mounted = true;

      (async () => {
        try {
          const svg = await renderMermaidSvg(source, () => {
            if (!mounted) return;
            setIsLoading(true);
            setError(null);
          });
          if (!mounted || svg === undefined) return;
          setRenderedContent(svg);
          setError(null);
        } catch (err) {
          if (mounted) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to render diagram';

            // Unsupported diagram types render as a plain code block below.
            if (
              errorMessage.includes('UnknownDiagramError') ||
              errorMessage.includes('No diagram type detected')
            ) {
              setError('unsupported_diagram_type');
            } else {
              setError(errorMessage);
            }
          }
        } finally {
          if (mounted) setIsLoading(false);
        }
      })();

      return () => {
        mounted = false;
      };
    }, [source]);

    // A diagram that already drew keeps its last SVG while a newer source
    // renders, and a streaming diagram shows no error for a half-written
    // source: the placeholder stands until there is something to draw.
    const showError = !!error && !isStreaming;
    if ((isLoading || (error && !showError)) && !renderedContent) {
      return (
        <div
          className={cn(
            'bg-muted/30 flex items-center justify-center rounded-lg border border-dashed p-8',
            className,
          )}
        >
          <div className="text-center">
            <div className="text-muted-foreground mb-2 text-sm">Rendering Mermaid diagram...</div>
            <KortixLoader size="medium" />
          </div>
        </div>
      );
    }

    if (showError) {
      // For unsupported diagram types, render as a simple code block
      if (error === 'unsupported_diagram_type') {
        return (
          <div className={cn('my-2', className)}>
            <div className="text-muted-foreground mb-1 text-xs">
              Unsupported diagram type (not available in Mermaid 11.x)
            </div>
            <pre className="bg-muted/50 overflow-x-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
              {chart}
            </pre>
          </div>
        );
      }

      // For other errors, show the full error UI
      return (
        <div className={cn('bg-muted/30 border-border/40 rounded-lg border p-4', className)}>
          <div className="text-muted-foreground mb-2 text-sm font-medium">
            Failed to render Mermaid diagram
          </div>
          <div className="text-muted-foreground bg-muted/50 rounded p-2 font-mono text-xs">
            {error}
          </div>
          <details className="mt-2">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
              Show diagram source
            </summary>
            <pre className="bg-muted/50 mt-2 overflow-x-auto rounded p-2 text-xs whitespace-pre-wrap">
              {chart}
            </pre>
          </details>
        </div>
      );
    }

    return (
      <>
        <style
          dangerouslySetInnerHTML={{
            __html: `
          .mermaid-container svg {
            max-width: 100% !important;
            height: auto !important;
            display: block !important;
            margin: 0 auto !important;
          }
          .mermaid-container .node :is(rect, polygon, circle, ellipse, path) {
            fill: var(--card) !important;
            stroke: var(--border) !important;
          }
          .mermaid-container .cluster rect {
            fill: var(--muted) !important;
            stroke: var(--border) !important;
          }
          .mermaid-container :is(text, .nodeLabel, .edgeLabel, .label) {
            fill: var(--foreground) !important;
            color: var(--foreground) !important;
            font-family: var(--font-sans) !important;
          }
          .mermaid-container :is(.edgePath path, .flowchart-link) {
            stroke: var(--muted-foreground) !important;
          }
          .mermaid-container :is(.marker, .arrowheadPath) {
            fill: var(--muted-foreground) !important;
            stroke: var(--muted-foreground) !important;
          }
          .mermaid-container .edgeLabel :is(rect, p) {
            background-color: var(--background) !important;
            fill: var(--background) !important;
          }
        `,
          }}
        />
        <div
          className={cn(
            'mermaid-container group bg-background relative my-4 w-full overflow-auto rounded-lg border',
            className,
          )}
        >
          {/* Inline controls — reveal on hover/focus */}
          <div className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <ButtonGroup>
              {actions}
              {enableFullscreen && (
                <Hint label="Fullscreen" side="top">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={handleFullscreenOpen}
                    className="bg-background/90 backdrop-blur-sm"
                    aria-label="Open diagram fullscreen"
                  >
                    <Maximize2 className="size-3.5" />
                  </Button>
                </Hint>
              )}
              <Hint label={copied ? 'Copied' : 'Copy source'} side="top">
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={handleCopySource}
                  className="bg-background/90 backdrop-blur-sm"
                  aria-label="Copy diagram source"
                >
                  {copied ? (
                    <Check className="text-kortix-green size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </Button>
              </Hint>
            </ButtonGroup>
          </div>

          <div ref={containerRef} dangerouslySetInnerHTML={{ __html: renderedContent }} />
        </div>

        {/* Fullscreen viewer — Modal with zoom / rotate canvas */}
        <Modal open={isFullscreenOpen} onOpenChange={setIsFullscreenOpen}>
          <ModalContent
            variant="base"
            showCloseButton={false}
            className="flex h-[90vh] flex-col space-y-0 overflow-hidden lg:h-[90vh] lg:max-w-7xl"
            closeButtonChildren={
              <ButtonGroup>
                <Hint label="Zoom in" side="bottom">
                  <Button variant="outline" size="icon" onClick={handleZoomIn} aria-label="Zoom in">
                    <ZoomIn className="size-4" />
                  </Button>
                </Hint>
                <Hint label="Zoom out" side="bottom">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleZoomOut}
                    aria-label="Zoom out"
                  >
                    <ZoomOut className="size-4" />
                  </Button>
                </Hint>
                <Hint label="Rotate" side="bottom">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleRotate}
                    aria-label="Rotate diagram"
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                </Hint>
                <ModalClose asChild>
                  <Button variant="outline" size="icon" aria-label="Close">
                    <X className="size-4" />
                  </Button>
                </ModalClose>
              </ButtonGroup>
            }
          >
            <ModalTitle className="sr-only">Diagram</ModalTitle>
            <ModalBody className="relative min-h-0 flex-1 space-y-0 p-0">
              <div
                ref={canvasRef}
                className="bg-muted/10 absolute inset-0 touch-none overflow-hidden select-none"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
              >
                {renderedContent ? (
                  <div
                    className="mermaid-container absolute inset-0 flex items-center justify-center"
                    style={{
                      transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom}) rotate(${rotation}deg)`,
                      transformOrigin: 'center center',
                      transition: isDragging ? 'none' : 'transform 0.15s ease-out',
                    }}
                    dangerouslySetInnerHTML={{ __html: renderedContent }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <KortixLoader size="medium" />
                  </div>
                )}
              </div>
            </ModalBody>
          </ModalContent>
        </Modal>
      </>
    );
  },
);

MermaidRenderer.displayName = 'MermaidRenderer';
