'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Conway's Game of Life that seeds itself from the current Kortix logo,
 * then lets the simulation evolve. A port of the original kortix-web
 * landing animation (github.com/kortix-ai/kortix-web) onto the latest
 * Kortix brandmark, rendered on a blank white page.
 */
export function GameOfLife() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<number[][]>([]);
  const animationRef = useRef<number>(undefined);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cellSize = 5;
    let cols = Math.floor(window.innerWidth / cellSize);
    let rows = Math.floor(window.innerHeight / cellSize);
    let frameCount = 0;
    const symbolDuration = 120;
    const stagnationThreshold = 300;
    let lastChangeCount = 0;
    let stagnantFrames = 0;

    // Current Kortix logo: full horizontal logomark on desktop, brandmark on mobile.
    const logoPath = isMobile
      ? '/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg'
      : '/brandkit/Logo/Logomark/SVG/Logomark Black.svg';

    const initializeGrid = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      cols = Math.floor(canvas.width / cellSize);
      rows = Math.floor(canvas.height / cellSize);
      gridRef.current = Array(cols)
        .fill(null)
        .map(() => Array(rows).fill(0));
      frameCount = 0;
    };

    const addRandomCells = () => {
      const randomCellCount = Math.floor(cols * rows * 0.01);
      for (let i = 0; i < randomCellCount; i++) {
        const x = Math.floor(Math.random() * cols);
        const y = Math.floor(Math.random() * rows);
        if (gridRef.current[x]) {
          gridRef.current[x][y] = 1;
        }
      }
    };

    const setKortixLogo = () => {
      const img = new Image();
      img.src = logoPath;

      img.onload = () => {
        if (!canvas || !ctx) return;

        const aspectRatio = img.width / img.height;

        // Everything below works in GRID-CELL units (cols × rows), so the logo
        // size is predictable and the simulation reads it crisply. We size the
        // logo as a fraction of the grid and clamp so it always fits, then
        // center it exactly.
        const widthFactor = isMobile ? 0.72 : 0.5; // fraction of grid width
        const maxHeightFactor = isMobile ? 0.5 : 0.55; // fraction of grid height

        let logoCols = Math.round(cols * widthFactor);
        let logoRows = Math.round(logoCols / aspectRatio);
        if (logoRows > rows * maxHeightFactor) {
          logoRows = Math.round(rows * maxHeightFactor);
          logoCols = Math.round(logoRows * aspectRatio);
        }

        // Fresh grid before stamping the logo in.
        gridRef.current = Array(cols)
          .fill(null)
          .map(() => Array(rows).fill(0));

        // Render the logo into an offscreen canvas exactly logoCols × logoRows,
        // then map each pixel to one grid cell and copy it into the centered
        // region of the grid.
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) return;

        tempCanvas.width = logoCols;
        tempCanvas.height = logoRows;
        tempCtx.drawImage(img, 0, 0, logoCols, logoRows);

        const offsetX = Math.floor((cols - logoCols) / 2);
        const offsetY = Math.floor((rows - logoRows) / 2);

        const imageData = tempCtx.getImageData(0, 0, logoCols, logoRows);
        for (let x = 0; x < logoCols; x++) {
          for (let y = 0; y < logoRows; y++) {
            const alpha = imageData.data[(y * logoCols + x) * 4 + 3];
            if (alpha > 32) {
              const gx = offsetX + x;
              const gy = offsetY + y;
              if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) {
                gridRef.current[gx][gy] = 1;
              }
            }
          }
        }
      };
    };

    const drawGrid = () => {
      if (!ctx || !canvas || !gridRef.current) return;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let currentChangeCount = 0;

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if (gridRef.current[i]?.[j]) {
            currentChangeCount++;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(i * cellSize, j * cellSize, cellSize - 1, cellSize - 1);
          }
        }
      }

      if (currentChangeCount === lastChangeCount) {
        stagnantFrames++;
        if (stagnantFrames > stagnationThreshold) {
          addRandomCells();
          stagnantFrames = 0;
        }
      } else {
        stagnantFrames = 0;
      }

      lastChangeCount = currentChangeCount;
    };

    const countNeighbors = (x: number, y: number) => {
      let sum = 0;
      for (let i = -1; i < 2; i++) {
        for (let j = -1; j < 2; j++) {
          const col = (x + i + cols) % cols;
          const row = (y + j + rows) % rows;
          sum += gridRef.current[col]?.[row] || 0;
        }
      }
      sum -= gridRef.current[x]?.[y] || 0;
      return sum;
    };

    const updateGrid = () => {
      const next = Array(cols)
        .fill(null)
        .map(() => Array(rows).fill(0));

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const state = gridRef.current[i]?.[j] || 0;
          const neighbors = countNeighbors(i, j);

          if (state === 0 && neighbors === 3) {
            next[i][j] = 1;
          } else if (state === 1 && (neighbors < 2 || neighbors > 3)) {
            next[i][j] = 0;
          } else {
            next[i][j] = state;
          }
        }
      }

      gridRef.current = next;
    };

    const animate = () => {
      if (!ctx) return;

      drawGrid();

      if (frameCount >= symbolDuration) {
        updateGrid();
      }

      frameCount++;
      animationRef.current = requestAnimationFrame(animate);
    };

    const handleResize = debounce(() => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      initializeGrid();
      setKortixLogo();
      frameCount = 0;
      animationRef.current = requestAnimationFrame(animate);
    }, 250);

    initializeGrid();
    setKortixLogo();
    animate();

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isMobile]);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />;
}

function debounce<T extends (...args: never[]) => void>(func: T, wait: number) {
  let timeout: ReturnType<typeof setTimeout>;
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
