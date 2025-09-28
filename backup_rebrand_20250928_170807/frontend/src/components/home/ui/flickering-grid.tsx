'use client';

import { cn, colorWithOpacity, getRGBA } from '@/lib/utils';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

interface FlickeringGridProps extends React.HTMLAttributes<HTMLDivElement> {
  squareSize?: number;
  gridGap?: number;
  flickerChance?: number;
  color?: string; // Can be any valid CSS color including hex, rgb, rgba, hsl, var(--color)
  width?: number;
  height?: number;
  className?: string;
  maxOpacity?: number;
  text?: string;
  textColor?: string;
  fontSize?: number;
  fontWeight?: number | string;
}

export const FlickeringGrid: React.FC<FlickeringGridProps> = ({
  squareSize = 3,
  gridGap = 3,
  flickerChance = 0.2,
  color = '#B4B4B4',
  width,
  height,
  className,
  maxOpacity = 0.15,
  text = '',
  fontSize = 140,
  fontWeight = 600,
  ...props
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const lastRenderTimeRef = useRef<number>(0);
  const lastResizeTimeRef = useRef<number>(0);
  const gridParamsRef = useRef<any>(null);
  const [isInView, setIsInView] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Throttle rendering to improve performance - adjust ms as needed
  const FRAME_THROTTLE = 50; // Only render every ~50ms (20fps instead of 60fps)
  const RESIZE_THROTTLE = 200; // Throttle resize events

  // Convert any CSS color to rgba for optimal canvas performance
  const memoizedColor = useMemo(() => {
    return getRGBA(color);
  }, [color]);

  const drawGrid = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      width: number,
      height: number,
      cols: number,
      rows: number,
      squares: Float32Array,
      dpr: number,
    ) => {
      ctx.clearRect(0, 0, width, height);

      // Create a separate canvas for the text mask if needed
      let maskCanvas: HTMLCanvasElement | null = null;
      let maskCtx: CanvasRenderingContext2D | null = null;

      if (text) {
        maskCanvas = document.createElement('canvas');
        maskCanvas.width = width;
        maskCanvas.height = height;
        maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

        if (maskCtx) {
          // Draw text on mask canvas
          maskCtx.save();
          maskCtx.scale(dpr, dpr);
          maskCtx.fillStyle = 'white';
          maskCtx.font = `${fontWeight} ${fontSize}px "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          maskCtx.textAlign = 'center';
          maskCtx.textBaseline = 'middle';
          maskCtx.fillText(text, width / (2 * dpr), height / (2 * dpr));
          maskCtx.restore();
        }
      }

      // Batch squares by opacity for better performance
      const opacityMap = new Map<number, { x: number; y: number }[]>();

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = i * (squareSize + gridGap) * dpr;
          const y = j * (squareSize + gridGap) * dpr;
          const squareWidth = squareSize * dpr;
          const squareHeight = squareSize * dpr;

          let hasText = false;

          if (maskCtx && maskCanvas) {
            const maskData = maskCtx.getImageData(
              x,
              y,
              squareWidth,
              squareHeight,
            ).data;

            hasText = maskData.some(
              (value, index) => index % 4 === 0 && value > 0,
            );
          }

          const opacity = squares[i * rows + j];
          const finalOpacity = hasText
            ? Math.min(1, opacity * 3 + 0.4)
            : opacity;

          // Round opacity to 2 decimal places for batching
          const roundedOpacity = Math.round(finalOpacity * 100) / 100;

          if (!opacityMap.has(roundedOpacity)) {
            opacityMap.set(roundedOpacity, []);
          }

          opacityMap.get(roundedOpacity)?.push({ x, y });
        }
      }

      // Draw squares by opacity batch
      for (const [opacity, squares] of opacityMap.entries()) {
        ctx.fillStyle = colorWithOpacity(memoizedColor, opacity);

        for (const { x, y } of squares) {
          ctx.fillRect(x, y, squareSize * dpr, squareSize * dpr);
        }
      }
    },
    [memoizedColor, squareSize, gridGap, text, fontSize, fontWeight],
  );

  const setupCanvas = useCallback(
    (canvas: HTMLCanvasElement, width: number, height: number) => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const cols = Math.ceil(width / (squareSize + gridGap));
      const rows = Math.ceil(height / (squareSize + gridGap));

      // Check if we should preserve the existing grid state
      if (
        gridParamsRef.current &&
        gridParamsRef.current.cols === cols &&
        gridParamsRef.current.rows === rows
      ) {
        // Use existing squares array to maintain state
        return {
          cols,
          rows,
          squares: gridParamsRef.current.squares,
          dpr,
        };
      }

      // Create new squares array only if needed
      const squares = new Float32Array(cols * rows);
      for (let i = 0; i < squares.length; i++) {
        squares[i] = Math.random() * maxOpacity;
      }

      return { cols, rows, squares, dpr };
    },
    [squareSize, gridGap, maxOpacity],
  );

  const updateSquares = useCallback(
    (squares: Float32Array, deltaTime: number) => {
      // Only update if flickerChance is greater than 0
      if (flickerChance <= 0) return;

      for (let i = 0; i < squares.length; i++) {
        if (Math.random() < flickerChance * deltaTime) {
          squares[i] = Math.random() * maxOpacity;
        }
      }
    },
    [flickerChance, maxOpacity],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const updateCanvasSize = () => {
      const now = performance.now();
      if (now - lastResizeTimeRef.current < RESIZE_THROTTLE) return;

      lastResizeTimeRef.current = now;
      const newWidth = width || container.clientWidth;
      const newHeight = height || container.clientHeight;

      // Only update if size changed to prevent unnecessary redraws
      if (canvasSize.width !== newWidth || canvasSize.height !== newHeight) {
        setCanvasSize({ width: newWidth, height: newHeight });

        // Don't recreate grid if sizes are similar (within 10px)
        const shouldPreserveGrid =
          gridParamsRef.current &&
          Math.abs(
            gridParamsRef.current.cols * (squareSize + gridGap) - newWidth,
          ) < 10 &&
          Math.abs(
            gridParamsRef.current.rows * (squareSize + gridGap) - newHeight,
          ) < 10;

        if (!shouldPreserveGrid) {
          gridParamsRef.current = setupCanvas(canvas, newWidth, newHeight);
        } else {
          // Just update canvas dimensions without recreating grid
          const dpr = window.devicePixelRatio || 1;
          canvas.width = newWidth * dpr;
          canvas.height = newHeight * dpr;
          canvas.style.width = `${newWidth}px`;
          canvas.style.height = `${newHeight}px`;
        }
      }
    };

    // Initialize canvas size and grid params if needed
    if (!gridParamsRef.current) {
      updateCanvasSize();
    }

    let lastTime = 0;
    const animate = (time: number) => {
      if (!isInView) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      // Throttle to improve performance
      if (time - lastRenderTimeRef.current < FRAME_THROTTLE) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      // Safety check
      if (!gridParamsRef.current || !gridParamsRef.current.squares) {
        updateCanvasSize();
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      lastRenderTimeRef.current = time;
      const deltaTime = (time - lastTime) / 1000;
      lastTime = time;

      updateSquares(gridParamsRef.current.squares, deltaTime);
      drawGrid(
        ctx,
        canvas.width,
        canvas.height,
        gridParamsRef.current.cols,
        gridParamsRef.current.rows,
        gridParamsRef.current.squares,
        gridParamsRef.current.dpr,
      );
      animationRef.current = requestAnimationFrame(animate);
    };

    // Use a gentle resize observer that doesn't completely redraw everything
    const resizeObserver = new ResizeObserver(() => {
      const now = performance.now();
      if (now - lastResizeTimeRef.current < RESIZE_THROTTLE) return;

      const newWidth = width || container.clientWidth;
      const newHeight = height || container.clientHeight;

      // Only update if dimensions actually changed significantly (at least 5px difference)
      if (
        Math.abs(canvasSize.width - newWidth) > 5 ||
        Math.abs(canvasSize.height - newHeight) > 5
      ) {
        updateCanvasSize();
      }
    });

    resizeObserver.observe(container);

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        setIsInView(entry.isIntersecting);
      },
      { threshold: 0.1, rootMargin: '50px' }, // Only activate when 10% visible with margin
    );

    intersectionObserver.observe(canvas);

    // Start animation if in view
    if (isInView) {
      animationRef.current = requestAnimationFrame(animate);
    }

    return () => {
      cancelAnimationFrame(animationRef.current);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, [
    setupCanvas,
    updateSquares,
    drawGrid,
    width,
    height,
    isInView,
    squareSize,
    gridGap,
  ]);

  return (
    <div
      ref={containerRef}
      className={cn(`h-full w-full ${className}`)}
      {...props}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none"
        style={{
          width: canvasSize.width,
          height: canvasSize.height,
        }}
      />
    </div>
  );
};
