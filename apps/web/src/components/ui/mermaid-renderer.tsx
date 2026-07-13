'use client';

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import { cn } from '@/lib/utils';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalTitle,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { Maximize2, X, ZoomIn, ZoomOut, RotateCcw, Copy, Check } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';

// Global cache for rendered Mermaid diagrams
const mermaidCache = new Map<string, string>();
let mermaidInstance: any = null;

// Global cleanup function to remove any Mermaid error messages from the DOM
const cleanupMermaidErrors = () => {
  const allElements = document.querySelectorAll('div, span, p, text, tspan');
  let cleaned = 0;
  allElements.forEach((el) => {
    const textContent = el.textContent || '';
    if (
      textContent.includes('Syntax error in text') ||
      textContent.includes('mermaid version 11.12.0') ||
      textContent.trim() === 'Syntax error in text'
    ) {
      console.log('🧹 Global cleanup of Mermaid error element:', textContent);
      el.remove();
      cleaned++;
    }
  });

  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} Mermaid error elements`);
  }
};

interface MermaidRendererProps {
  chart: string;
  className?: string;
  enableFullscreen?: boolean;
}

export const MermaidRenderer: React.FC<MermaidRendererProps> = React.memo(
  ({ chart, className, enableFullscreen = true }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [renderedContent, setRenderedContent] = useState<string>('');
    const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);

    // Create a stable hash for the chart content to enable caching
    const chartHash = useMemo(() => {
      let hash = 0;
      const trimmed = chart.trim();
      for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return hash.toString(36);
    }, [chart]);

    // Canvas state for fullscreen viewer
    const canvasRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [lastTouchDistance, setLastTouchDistance] = useState<number | null>(
      null,
    );

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

    // Set up periodic cleanup of Mermaid error messages
    useEffect(() => {
      const cleanupInterval = setInterval(cleanupMermaidErrors, 5000); // Clean up every 5 seconds

      // Initial cleanup on mount
      cleanupMermaidErrors();

      return () => {
        clearInterval(cleanupInterval);
        // Final cleanup on unmount
        cleanupMermaidErrors();
      };
    }, []);

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
        Math.pow(touch2.clientX - touch1.clientX, 2) +
          Math.pow(touch2.clientY - touch1.clientY, 2),
      );
    };

    const getTouchCenter = (touches: React.TouchList) => {
      if (touches.length === 0) return { x: 0, y: 0 };
      if (touches.length === 1)
        return { x: touches[0].clientX, y: touches[0].clientY };

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
            const newZoom = Math.max(0.1, Math.min(5, zoom * zoomFactor));

            // Zoom towards touch center
            if (canvasRef.current) {
              const rect = canvasRef.current.getBoundingClientRect();
              const touchCenter = getTouchCenter(e.touches);
              const centerX = touchCenter.x - rect.left;
              const centerY = touchCenter.y - rect.top;

              const newPanOffset = {
                x: centerX - (centerX - panOffset.x) * (newZoom / zoom),
                y: centerY - (centerY - panOffset.y) * (newZoom / zoom),
              };

              setZoom(newZoom);
              setPanOffset(newPanOffset);
            }

            setLastTouchDistance(currentDistance);
          }
        }
      },
      [isDragging, dragStart, lastTouchDistance, zoom, panOffset],
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
        const newZoom = Math.max(0.1, Math.min(5, zoom * zoomFactor));

        // Zoom towards mouse position
        if (canvasRef.current) {
          const rect = canvasRef.current.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;

          const newPanOffset = {
            x: mouseX - (mouseX - panOffset.x) * (newZoom / zoom),
            y: mouseY - (mouseY - panOffset.y) * (newZoom / zoom),
          };

          setZoom(newZoom);
          setPanOffset(newPanOffset);
        }
      },
      [zoom, panOffset],
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
      let mounted = true;

      const renderChart = async () => {
        if (!chart.trim()) {
          if (mounted) setIsLoading(false);
          return;
        }

        // Check cache first
        const cachedResult = mermaidCache.get(chartHash);
        if (cachedResult) {
          console.log('🎯 Using cached Mermaid diagram for hash:', chartHash);
          if (mounted) {
            setRenderedContent(cachedResult);
            setIsLoading(false);
          }
          return;
        }

        try {
          if (mounted) {
            setIsLoading(true);
            setError(null);
          }

          console.log(
            '🎯 Starting Mermaid rendering for chart:',
            chart.substring(0, 50) + '...',
          );

          // Basic syntax validation before attempting to render
          const trimmedChart = chart.trim();
          if (!trimmedChart) {
            throw new Error('Empty chart content');
          }

          // Check for basic Mermaid syntax
          const firstLine = trimmedChart.split('\n')[0].toLowerCase().trim();
          const validStarters = [
            'graph',
            'flowchart',
            'sequencediagram',
            'sequence',
            'classdiagram',
            'class',
            'statediagram',
            'state',
            'erdiagram',
            'journey',
            'gantt',
            'pie',
            'gitgraph',
            'mindmap',
            'timeline',
            'sankey',
            'block',
            'quadrant',
            'requirement',
            'c4context',
            'c4container',
            'c4component',
            'c4dynamic',
          ];

          const hasValidStarter = validStarters.some(
            (starter) =>
              firstLine.startsWith(starter) || firstLine.includes(starter),
          );

          if (!hasValidStarter) {
            throw new Error(
              `Invalid diagram type. Chart must start with a valid Mermaid diagram type (e.g., graph, flowchart, sequenceDiagram, etc.). Found: "${firstLine}"`,
            );
          }

          // Use cached Mermaid instance or initialize new one
          if (!mermaidInstance) {
            const mermaid = (await import('mermaid')).default;
            await mermaid.initialize({
              startOnLoad: false,
              securityLevel: 'strict',
              theme: 'base',
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              // Enable experimental features including gitgraph
              gitGraph: {
                showBranches: true,
                showCommitLabel: true,
                mainBranchName: 'main',
                rotateCommitLabel: true,
              },
            });
            mermaidInstance = mermaid;
            console.log('✅ Mermaid initialized and cached');
          }

          // Create a unique ID for this chart
          const chartId = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

          console.log('🎯 Rendering chart with ID:', chartId);

          // Wrap Mermaid render in additional error handling to catch parsing errors
          let result;
          try {
            result = await mermaidInstance.render(chartId, trimmedChart);
          } catch (renderError) {
            // Handle specific Mermaid parsing errors
            const errorMessage =
              renderError instanceof Error
                ? renderError.message
                : String(renderError);
            console.error('🚨 Mermaid parsing error:', errorMessage);

            // Remove any error elements that Mermaid might have added to the DOM
            const errorElement = document.getElementById(chartId);
            if (errorElement) {
              errorElement.remove();
            }

            // Throw a more user-friendly error
            if (
              errorMessage.includes('Parse error') ||
              errorMessage.includes('Syntax error')
            ) {
              throw new Error(`Diagram syntax error: ${errorMessage}`);
            } else if (errorMessage.includes('UnknownDiagramError')) {
              throw new Error('unsupported_diagram_type');
            } else {
              throw new Error(`Failed to render diagram: ${errorMessage}`);
            }
          }

          if (!mounted) return;

          console.log(
            '✅ Chart rendered successfully, SVG length:',
            result.svg.length,
          );

          // Cache the result
          mermaidCache.set(chartHash, result.svg);

          // Set the rendered content
          setRenderedContent(result.svg);

          // Clean up any potential error text or elements that might have been added to the DOM
          setTimeout(cleanupMermaidErrors, 100);
        } catch (err) {
          console.error('❌ Mermaid rendering error:', err);

          // Clean up any error elements that might have been added to the DOM
          setTimeout(cleanupMermaidErrors, 50);

          if (mounted) {
            const errorMessage =
              err instanceof Error ? err.message : 'Failed to render diagram';

            // Check if it's an unsupported diagram type
            if (
              errorMessage.includes('UnknownDiagramError') ||
              errorMessage.includes('No diagram type detected')
            ) {
              // For unsupported diagrams, show as code block instead of large error
              console.log(
                '🔄 Unsupported Mermaid diagram type, falling back to code block',
              );
              setError('unsupported_diagram_type');
            } else {
              setError(errorMessage);
            }
          }
        } finally {
          if (mounted) {
            setIsLoading(false);
            console.log('🏁 Mermaid rendering completed');
          }
        }
      };

      renderChart();

      return () => {
        mounted = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chartHash]);

    if (isLoading) {
      return (
        <div
          className={cn(
            'flex items-center justify-center p-8 bg-muted/30 rounded-lg border border-dashed',
            className,
          )}
        >
          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-2">
              🎨 Rendering Mermaid diagram...
            </div>
            <KortixLoader size="medium" />
          </div>
        </div>
      );
    }

    if (error) {
      // For unsupported diagram types, render as a simple code block
      if (error === 'unsupported_diagram_type') {
        return (
          <div className={cn('my-2', className)}>
            <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <span>⚠️</span>
              <span>
                Unsupported diagram type (not available in Mermaid 11.x)
              </span>
            </div>
            <pre className="text-xs p-3 bg-muted/50 border rounded-lg overflow-x-auto whitespace-pre-wrap font-mono">
              {chart}
            </pre>
          </div>
        );
      }

      // For other errors, show the full error UI
      return (
        <div
          className={cn(
            'p-4 bg-muted/30 border border-border/40 rounded-lg',
            className,
          )}
        >
          <div className="text-sm text-muted-foreground font-medium mb-2">
            Failed to render Mermaid diagram
          </div>
          <div className="text-xs text-muted-foreground font-mono bg-muted/50 p-2 rounded">
            {error}
          </div>
          <details className="mt-2">
            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
              📄 Show diagram source
            </summary>
            <pre className="text-xs mt-2 p-2 bg-muted/50 rounded overflow-x-auto whitespace-pre-wrap">
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
          .mermaid-container .node {
            fill: hsl(var(--card)) !important;
            stroke: hsl(var(--foreground)) !important;
          }
          .mermaid-container .cluster {
            fill: hsl(var(--muted)) !important;
            stroke: hsl(var(--foreground)) !important;
          }
          .mermaid-container text {
            fill: hsl(var(--foreground)) !important;
            font-family: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif !important;
          }
          .mermaid-container .edgePath {
            stroke: hsl(var(--foreground)) !important;
          }
          .mermaid-container .marker {
            fill: hsl(var(--foreground)) !important;
          }
        `,
          }}
        />
        <div
          className={cn(
            'mermaid-container group relative my-4 w-full overflow-auto rounded-lg border bg-background',
            className,
          )}
          style={{ minHeight: '200px' }}
        >
          {/* Inline controls — reveal on hover/focus */}
          <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <ButtonGroup>
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
                    <Check className="size-3.5 text-kortix-green" />
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
                  <Button variant="outline" size="icon" onClick={handleZoomOut} aria-label="Zoom out">
                    <ZoomOut className="size-4" />
                  </Button>
                </Hint>
                <Hint label="Rotate" side="bottom">
                  <Button variant="outline" size="icon" onClick={handleRotate} aria-label="Rotate diagram">
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
                className="absolute inset-0 touch-none select-none overflow-hidden bg-muted/10"
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
