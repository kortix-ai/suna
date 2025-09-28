'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Maximize2, X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

// Global cache for rendered Mermaid diagrams
const mermaidCache = new Map<string, string>();
let mermaidInstance: any = null;

// Global cleanup function to remove any Mermaid error messages from the DOM
const cleanupMermaidErrors = () => {
  const allElements = document.querySelectorAll('div, span, p, text, tspan');
  let cleaned = 0;
  allElements.forEach(el => {
    const textContent = el.textContent || '';
    if (textContent.includes('Syntax error in text') || 
        textContent.includes('mermaid version 11.12.0') ||
        textContent.trim() === 'Syntax error in text') {
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

export const MermaidRenderer: React.FC<MermaidRendererProps> = React.memo(({
  chart,
  className,
  enableFullscreen = true
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [renderedContent, setRenderedContent] = useState<string>('');
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const [fullscreenRenderedContent, setFullscreenRenderedContent] = useState<string>('');

  // Create a stable hash for the chart content to enable caching
  const chartHash = useMemo(() => {
    let hash = 0;
    const trimmed = chart.trim();
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }, [chart]);

  // Canvas state for fullscreen viewer
  const canvasRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [lastTouchDistance, setLastTouchDistance] = useState<number | null>(null);

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
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) { // Left mouse button
      setIsDragging(true);
      setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    }
  }, [panOffset]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      const newOffset = {
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      };
      setPanOffset(newOffset);
    }
  }, [isDragging, dragStart]);

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
      Math.pow(touch2.clientY - touch1.clientY, 2)
    );
  };

  const getTouchCenter = (touches: React.TouchList) => {
    if (touches.length === 0) return { x: 0, y: 0 };
    if (touches.length === 1) return { x: touches[0].clientX, y: touches[0].clientY };

    const touch1 = touches[0];
    const touch2 = touches[1];
    return {
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2
    };
  };

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      // Single touch - start panning
      setIsDragging(true);
      setDragStart({
        x: e.touches[0].clientX - panOffset.x,
        y: e.touches[0].clientY - panOffset.y
      });
    } else if (e.touches.length === 2) {
      // Two touches - start pinch zoom
      setIsDragging(false);
      setLastTouchDistance(getTouchDistance(e.touches));
    }
  }, [panOffset]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    // Only prevent default if we're actively interacting with the canvas
    if (isDragging || (e.touches.length === 2 && lastTouchDistance)) {
      e.preventDefault();
    }

    if (e.touches.length === 1 && isDragging) {
      // Single touch - pan
      const newOffset = {
        x: e.touches[0].clientX - dragStart.x,
        y: e.touches[0].clientY - dragStart.y
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
            y: centerY - (centerY - panOffset.y) * (newZoom / zoom)
          };

          setZoom(newZoom);
          setPanOffset(newPanOffset);
        }

        setLastTouchDistance(currentDistance);
      }
    }
  }, [isDragging, dragStart, lastTouchDistance, zoom, panOffset]);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    setLastTouchDistance(null);
  }, []);

  // Wheel event handler - attached manually to avoid passive event issues
  const handleWheelEvent = useCallback((e: WheelEvent) => {
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
        y: mouseY - (mouseY - panOffset.y) * (newZoom / zoom)
      };

      setZoom(newZoom);
      setPanOffset(newPanOffset);
    }
  }, [zoom, panOffset]);

  // Attach wheel event listener manually with passive: false
  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (canvasElement && isFullscreenOpen) {
      canvasElement.addEventListener('wheel', handleWheelEvent, { passive: false });
      return () => {
        canvasElement.removeEventListener('wheel', handleWheelEvent);
      };
    }
  }, [isFullscreenOpen, handleWheelEvent]);

  // Simple zoom controls
  const handleZoomIn = () => setZoom(prev => Math.min(5, prev * 1.2));
  const handleZoomOut = () => setZoom(prev => Math.max(0.1, prev * 0.8));
  const handleResetView = () => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  };
  const handleFitToViewport = () => {
    setZoom(0.8);
    setPanOffset({ x: 0, y: 0 });
  };

  const handleFullscreenOpen = () => {
    if (enableFullscreen) {
      setIsFullscreenOpen(true);
      // Reset canvas state
      setZoom(0.8); // Start with a reasonable fit
      setPanOffset({ x: 0, y: 0 });
      setIsDragging(false);
      // Render diagram for fullscreen
      renderChartForFullscreen();
    }
  };

  const renderChartForFullscreen = async () => {
    try {
      // Check cache first for fullscreen
      const cachedResult = mermaidCache.get(chartHash);
      if (cachedResult) {
        setFullscreenRenderedContent(cachedResult);
        return;
      }

      // Use cached Mermaid instance or initialize new one
      if (!mermaidInstance) {
        const mermaid = (await import('mermaid')).default;
        await mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: 'base',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          // Enable experimental features including gitgraph
          gitGraph: {
            showBranches: true,
            showCommitLabel: true,
            mainBranchName: 'main',
            rotateCommitLabel: true
          }
        });
        mermaidInstance = mermaid;
      }

      const chartId = `mermaid-fullscreen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const result = await mermaidInstance.render(chartId, chart);

      // Cache the fullscreen result too
      mermaidCache.set(chartHash, result.svg);
      setFullscreenRenderedContent(result.svg);
    } catch (err) {
      console.error('Fullscreen rendering error:', err);
      // For fullscreen, show a fallback message instead of crashing
      if (isFullscreenOpen) {
        setFullscreenRenderedContent(`
          <div style="display: flex; align-items: center; justify-content: center; height: 200px; color: #6b7280; font-family: ui-sans-serif, system-ui, sans-serif;">
            <div style="text-align: center;">
              <div style="font-size: 24px; margin-bottom: 8px;">📊</div>
              <div>Diagram rendering failed</div>
              <div style="font-size: 12px; margin-top: 4px; opacity: 0.7;">Check diagram syntax</div>
            </div>
          </div>
        `);
      }
    }
  };

  // Keyboard shortcuts for fullscreen viewer
  useEffect(() => {
    if (!isFullscreenOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          setIsFullscreenOpen(false);
          break;
        case '+':
        case '=':
          e.preventDefault();
          handleZoomIn();
          break;
        case '-':
          e.preventDefault();
          handleZoomOut();
          break;
        case '0':
          e.preventDefault();
          handleResetView();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          handleFitToViewport();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreenOpen]);

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

        console.log('🎯 Starting Mermaid rendering for chart:', chart.substring(0, 50) + '...');

        // Basic syntax validation before attempting to render
        const trimmedChart = chart.trim();
        if (!trimmedChart) {
          throw new Error('Empty chart content');
        }

        // Check for basic Mermaid syntax
        const firstLine = trimmedChart.split('\n')[0].toLowerCase().trim();
        const validStarters = [
          'graph', 'flowchart', 'sequencediagram', 'sequence', 'classdiagram', 'class',
          'statediagram', 'state', 'erdiagram', 'journey', 'gantt', 'pie',
          'gitgraph', 'mindmap', 'timeline', 'sankey', 'block',
          'quadrant', 'requirement', 'c4context', 'c4container',
          'c4component', 'c4dynamic'
        ];
        
        const hasValidStarter = validStarters.some(starter => 
          firstLine.startsWith(starter) || firstLine.includes(starter)
        );

        if (!hasValidStarter) {
          throw new Error(`Invalid diagram type. Chart must start with a valid Mermaid diagram type (e.g., graph, flowchart, sequenceDiagram, etc.). Found: "${firstLine}"`);
        }

        // Use cached Mermaid instance or initialize new one
        if (!mermaidInstance) {
          const mermaid = (await import('mermaid')).default;
          await mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: 'base',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            // Enable experimental features including gitgraph
            gitGraph: {
              showBranches: true,
              showCommitLabel: true,
              mainBranchName: 'main',
              rotateCommitLabel: true
            }
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
          const errorMessage = renderError instanceof Error ? renderError.message : String(renderError);
          console.error('🚨 Mermaid parsing error:', errorMessage);
          
          // Remove any error elements that Mermaid might have added to the DOM
          const errorElement = document.getElementById(chartId);
          if (errorElement) {
            errorElement.remove();
          }
          
          // Throw a more user-friendly error
          if (errorMessage.includes('Parse error') || errorMessage.includes('Syntax error')) {
            throw new Error(`Diagram syntax error: ${errorMessage}`);
          } else if (errorMessage.includes('UnknownDiagramError')) {
            throw new Error('unsupported_diagram_type');
          } else {
            throw new Error(`Failed to render diagram: ${errorMessage}`);
          }
        }

        if (!mounted) return;

        console.log('✅ Chart rendered successfully, SVG length:', result.svg.length);

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
          const errorMessage = err instanceof Error ? err.message : 'Failed to render diagram';
          
          // Check if it's an unsupported diagram type
          if (errorMessage.includes('UnknownDiagramError') || errorMessage.includes('No diagram type detected')) {
            // For unsupported diagrams, show as code block instead of large error
            console.log('🔄 Unsupported Mermaid diagram type, falling back to code block');
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
  }, [chartHash]);

  if (isLoading) {
    return (
      <div className={cn(
        'flex items-center justify-center p-8 bg-muted/30 rounded-md border border-dashed',
        className
      )}>
        <div className="text-center">
          <div className="text-sm text-muted-foreground mb-2">🎨 Rendering Mermaid diagram...</div>
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary mx-auto"></div>
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
            <span>Unsupported diagram type (not available in Mermaid 11.x)</span>
          </div>
          <pre className="text-xs p-3 bg-muted/50 border rounded-md overflow-x-auto whitespace-pre-wrap font-mono">
            {chart}
          </pre>
        </div>
      );
    }

    // For other errors, show the full error UI
    return (
      <div className={cn(
        'p-4 bg-destructive/10 border border-destructive/20 rounded-md',
        className
      )}>
        <div className="text-sm text-destructive font-medium mb-2">
          ❌ Failed to render Mermaid diagram
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
      <style dangerouslySetInnerHTML={{
        __html: `
          .mermaid-container svg {
            max-width: 100% !important;
            height: auto !important;
            display: block !important;
            margin: 0 auto !important;
          }
          .mermaid-container .node {
            fill: hsl(var(--card)) !important;
            stroke: hsl(var(--border)) !important;
          }
          .mermaid-container .cluster {
            fill: hsl(var(--muted)) !important;
            stroke: hsl(var(--border)) !important;
          }
          .mermaid-container text {
            fill: hsl(var(--foreground)) !important;
            font-family: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif !important;
          }
          .mermaid-container .edgePath {
            stroke: hsl(var(--border)) !important;
          }
          .mermaid-container .marker {
            fill: hsl(var(--border)) !important;
          }

          /* Fullscreen modal specific styles */
          .mermaid-fullscreen-modal svg {
            max-width: 100% !important;
            max-height: 100% !important;
            width: auto !important;
            height: auto !important;
            display: block !important;
            margin: 0 auto !important;
          }

          .mermaid-fullscreen-modal .mermaid-container {
            max-width: 100% !important;
            max-height: 100% !important;
            overflow: auto !important;
            padding: 1rem !important;
          }

          /* Ensure diagrams don't overflow their containers */
          .mermaid-fullscreen-modal {
            width: 100% !important;
            height: 100% !important;
            display: flex !important;
            align-items: flex-start !important;
            justify-content: center !important;
          }
        `
      }} />
      <div
        className={cn(
          'mermaid-container my-4 rounded-md border overflow-auto bg-background relative group cursor-pointer',
          enableFullscreen && 'hover:ring-2 hover:ring-primary/20',
          className
        )}
        style={{
          minHeight: '200px',
          width: '100%'
        }}
        onClick={enableFullscreen ? handleFullscreenOpen : undefined}
      >
        <div
          ref={containerRef}
          dangerouslySetInnerHTML={{ __html: renderedContent }}
        />
        {enableFullscreen && (
          <div className="absolute inset-0 bg-black/0 hover:bg-black/5 transition-colors rounded-md flex items-center justify-center opacity-0 hover:opacity-100 pointer-events-none">
            <Button
              variant="secondary"
              size="sm"
              className="h-8 w-8 p-0 bg-background/90 hover:bg-background border shadow-sm pointer-events-auto"
              onClick={(e) => {
                e.stopPropagation();
                handleFullscreenOpen();
              }}
              title="View fullscreen"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Fullscreen Modal with Canvas Controls */}
      <Dialog open={isFullscreenOpen} onOpenChange={setIsFullscreenOpen}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] w-full h-full p-0 overflow-hidden">
          <div className="flex flex-col h-full bg-background">
            {/* Header with controls */}
            <div className="flex items-center justify-between p-4 pr-16 border-b bg-background/95 backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <DialogTitle className="text-sm font-medium">Mermaid Diagram</DialogTitle>
                <span className="text-xs text-muted-foreground">
                  Zoom: {Math.round(zoom * 100)}%
                </span>
              </div>

              {/* Canvas controls - Dialog has its own close button */}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleZoomOut}
                  className="h-8 w-8 p-0"
                  title="Zoom out"
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleResetView}
                  className="h-8 w-8 p-0"
                  title="Reset view"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleZoomIn}
                  className="h-8 w-8 p-0"
                  title="Zoom in"
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleFitToViewport}
                  className="h-8 px-3"
                  title="Fit to viewport"
                >
                  Fit
                </Button>
              </div>
            </div>

            {/* Canvas area */}
            <div
              ref={canvasRef}
              className="flex-1 min-h-0 relative overflow-hidden bg-muted/10 cursor-move touch-none select-none"
              onClick={(e) => e.stopPropagation()} // Prevent dialog from closing on canvas clicks
              onMouseDown={(e) => {
                e.stopPropagation(); // Prevent dialog from closing
                handleMouseDown(e);
              }}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onTouchStart={(e) => {
                e.stopPropagation(); // Prevent dialog from closing
                handleTouchStart(e);
              }}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              style={{
                cursor: isDragging ? 'grabbing' : 'grab'
              }}
            >
              {fullscreenRenderedContent ? (
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{
                    transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: isDragging ? 'none' : 'transform 0.1s ease-out'
                  }}
                  dangerouslySetInnerHTML={{ __html: fullscreenRenderedContent }}
                />
              ) : (
                <div className="flex items-center justify-center h-full w-full">
                  <div className="text-center">
                    <div className="text-sm text-muted-foreground mb-2">🎨 Loading fullscreen diagram...</div>
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
                  </div>
                </div>
              )}

              {/* Canvas instructions */}
              <div className="absolute bottom-4 left-4 bg-background/80 backdrop-blur-sm rounded-md px-3 py-2 text-xs text-muted-foreground shadow-sm">
                <div>Drag to pan • Scroll to zoom • Pinch to zoom</div>
                <div className="mt-1 opacity-75">Esc: close • +/-: zoom • 0: reset • F: fit</div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

MermaidRenderer.displayName = 'MermaidRenderer';