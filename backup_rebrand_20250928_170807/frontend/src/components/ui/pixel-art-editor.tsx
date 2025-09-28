import React, { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Eraser, Palette, RotateCcw, Save } from 'lucide-react';

interface PixelArtEditorProps {
  onSave: (pixelArt: string) => void;
  onCancel: () => void;
  initialPixelArt?: string;
  size?: number;
}

const GRID_SIZE = 16;
const COLORS = [
  '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
  '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#808080',
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57', '#FF9FF3', '#54A0FF', '#48DBFB'
];

export const PixelArtEditor: React.FC<PixelArtEditorProps> = ({
  onSave,
  onCancel,
  initialPixelArt,
  size = 400
}) => {
  const [grid, setGrid] = useState<string[][]>(() => {
    // Initialize grid with transparent pixels
    const initialGrid = Array(GRID_SIZE).fill(null).map(() => 
      Array(GRID_SIZE).fill('transparent')
    );
    
    // If there's initial pixel art, try to parse it
    if (initialPixelArt) {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(initialPixelArt, 'image/svg+xml');
        const rects = doc.querySelectorAll('rect');
        
        rects.forEach(rect => {
          const x = parseInt(rect.getAttribute('x') || '0');
          const y = parseInt(rect.getAttribute('y') || '0');
          const width = parseInt(rect.getAttribute('width') || '1');
          const height = parseInt(rect.getAttribute('height') || '1');
          const fill = rect.getAttribute('fill') || 'currentColor';
          
          // Fill the grid based on the rect
          for (let row = y; row < y + height && row < GRID_SIZE; row++) {
            for (let col = x; col < x + width && col < GRID_SIZE; col++) {
              if (row >= 0 && col >= 0) {
                initialGrid[row][col] = fill;
              }
            }
          }
        });
      } catch (error) {
        console.warn('Failed to parse initial pixel art:', error);
      }
    }
    
    return initialGrid;
  });

  const [selectedColor, setSelectedColor] = useState('#000000');
  const [isErasing, setIsErasing] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  const handlePixelClick = useCallback((row: number, col: number) => {
    setGrid(prev => {
      const newGrid = prev.map(r => [...r]);
      newGrid[row][col] = isErasing ? 'transparent' : selectedColor;
      return newGrid;
    });
  }, [selectedColor, isErasing]);

  const handleMouseDown = useCallback((row: number, col: number) => {
    setIsDrawing(true);
    handlePixelClick(row, col);
  }, [handlePixelClick]);

  const handleMouseEnter = useCallback((row: number, col: number) => {
    if (isDrawing) {
      handlePixelClick(row, col);
    }
  }, [isDrawing, handlePixelClick]);

  const handleMouseUp = useCallback(() => {
    setIsDrawing(false);
  }, []);

  const clearGrid = useCallback(() => {
    setGrid(Array(GRID_SIZE).fill(null).map(() => 
      Array(GRID_SIZE).fill('transparent')
    ));
  }, []);

  const generateSVG = useCallback(() => {
    const rects: string[] = [];
    const visited = Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill(false));
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        if (!visited[row][col] && grid[row][col] !== 'transparent') {
          const color = grid[row][col];
          let width = 1;
          let height = 1;
          while (col + width < GRID_SIZE && 
                 grid[row][col + width] === color && 
                 !visited[row][col + width]) {
            width++;
          }
          let canExtendHeight = true;
          while (row + height < GRID_SIZE && canExtendHeight) {
            for (let c = col; c < col + width; c++) {
              if (grid[row + height][c] !== color || visited[row + height][c]) {
                canExtendHeight = false;
                break;
              }
            }
            if (canExtendHeight) height++;
          }
          for (let r = row; r < row + height; r++) {
            for (let c = col; c < col + width; c++) {
              visited[r][c] = true;
            }
          }
          const fill = color === 'currentColor' ? 'currentColor' : color;
          rects.push(`<rect x="${col}" y="${row}" width="${width}" height="${height}" fill="${fill}"/>`);
        }
      }
    }
    return `<svg viewBox="0 0 ${GRID_SIZE} ${GRID_SIZE}" xmlns="http://www.w3.org/2000/svg">\n  ${rects.join('\n  ')}\n</svg>`;
  }, [grid]);

  const handleSave = useCallback(() => {
    const svg = generateSVG();
    onSave(svg);
  }, [generateSVG, onSave]);

  const pixelSize = size / GRID_SIZE;

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="h-5 w-5" />
          Pixel Art Editor
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Colors:</span>
            <Button
              variant={isErasing ? "default" : "outline"}
              size="sm"
              onClick={() => setIsErasing(!isErasing)}
            >
              <Eraser className="h-4 w-4" />
              {isErasing ? "Erasing" : "Eraser"}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {COLORS.map(color => (
              <button
                key={color}
                className={`w-8 h-8 rounded border-2 ${
                  selectedColor === color && !isErasing
                    ? 'border-primary ring-2 ring-primary/20' 
                    : 'border-border'
                }`}
                style={{ backgroundColor: color }}
                onClick={() => {
                  setSelectedColor(color);
                  setIsErasing(false);
                }}
                title={color}
              />
            ))}
            <button
              className={`w-8 h-8 rounded border-2 ${
                selectedColor === 'currentColor' && !isErasing
                  ? 'border-primary ring-2 ring-primary/20' 
                  : 'border-border'
              } bg-gradient-to-br from-blue-500 to-purple-500`}
              onClick={() => {
                setSelectedColor('currentColor');
                setIsErasing(false);
              }}
              title="Theme Color"
            >
              <span className="text-white text-xs font-bold">T</span>
            </button>
          </div>
        </div>
        <div className="flex justify-center">
          <div 
            className="grid border-2 border-border bg-white dark:bg-gray-900 relative"
            style={{ 
              gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)`,
              width: size,
              height: size
            }}
            onMouseLeave={handleMouseUp}
          >
            {grid.map((row, rowIndex) =>
              row.map((pixel, colIndex) => (
                <div
                  key={`${rowIndex}-${colIndex}`}
                  className="border border-gray-200 dark:border-gray-700 cursor-pointer hover:opacity-80"
                  style={{
                    backgroundColor: pixel === 'transparent' ? 'transparent' : 
                                   pixel === 'currentColor' ? '#3b82f6' : pixel,
                    width: pixelSize,
                    height: pixelSize
                  }}
                  onMouseDown={() => handleMouseDown(rowIndex, colIndex)}
                  onMouseEnter={() => handleMouseEnter(rowIndex, colIndex)}
                  onMouseUp={handleMouseUp}
                />
              ))
            )}
          </div>
        </div>
        <div className="space-y-2">
          <span className="text-sm font-medium">Preview:</span>
          <div className="flex items-center gap-4">
            <div 
              className="w-12 h-12 border rounded"
              style={{ backgroundColor: '#3b82f6', color: 'white' }}
              dangerouslySetInnerHTML={{ __html: generateSVG() }}
            />
            <div 
              className="w-12 h-12 border rounded"
              style={{ backgroundColor: '#ef4444', color: 'white' }}
              dangerouslySetInnerHTML={{ __html: generateSVG() }}
            />
            <div 
              className="w-12 h-12 border rounded"
              style={{ backgroundColor: '#10b981', color: 'white' }}
              dangerouslySetInnerHTML={{ __html: generateSVG() }}
            />
          </div>
        </div>
        <div className="flex gap-2 justify-between">
          <Button variant="outline" onClick={clearGrid}>
            <RotateCcw className="h-4 w-4" />
            Clear
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              <Save className="h-4 w-4" />
              Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}; 