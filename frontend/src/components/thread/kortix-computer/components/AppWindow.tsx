'use client';

import { memo, useState, useRef, useCallback } from 'react';
import { motion, useDragControls, PanInfo } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Minus, Square, X } from 'lucide-react';

interface AppWindowProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  isActive: boolean;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  onFocus: () => void;
  onClose: () => void;
  onMinimize?: () => void;
  zIndex: number;
}

export const AppWindow = memo(function AppWindow({
  id,
  title,
  icon,
  children,
  isActive,
  initialPosition = { x: 100, y: 100 },
  initialSize = { width: 700, height: 500 },
  onFocus,
  onClose,
  onMinimize,
  zIndex,
}: AppWindowProps) {
  const [position, setPosition] = useState(initialPosition);
  const [size, setSize] = useState(initialSize);
  const [isMaximized, setIsMaximized] = useState(false);
  const [preMaximizeState, setPreMaximizeState] = useState({ position, size });
  const dragControls = useDragControls();
  const windowRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);

  const handleDragEnd = useCallback((_: any, info: PanInfo) => {
    if (!isMaximized) {
      setPosition(prev => ({
        x: prev.x + info.offset.x,
        y: prev.y + info.offset.y,
      }));
    }
  }, [isMaximized]);

  const handleMaximize = useCallback(() => {
    if (isMaximized) {
      setPosition(preMaximizeState.position);
      setSize(preMaximizeState.size);
      setIsMaximized(false);
    } else {
      setPreMaximizeState({ position, size });
      setPosition({ x: 20, y: 20 });
      setSize({ 
        width: window.innerWidth - 40, 
        height: window.innerHeight - 40 
      });
      setIsMaximized(true);
    }
  }, [isMaximized, position, size, preMaximizeState]);

  const handleResize = useCallback((e: React.MouseEvent, direction: string) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing.current = true;

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = size.width;
    const startHeight = size.height;
    const startPosX = position.x;
    const startPosY = position.y;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      let newWidth = startWidth;
      let newHeight = startHeight;
      let newX = startPosX;
      let newY = startPosY;

      if (direction.includes('e')) {
        newWidth = Math.max(400, startWidth + deltaX);
      }
      if (direction.includes('w')) {
        const widthDelta = Math.min(deltaX, startWidth - 400);
        newWidth = startWidth - widthDelta;
        newX = startPosX + widthDelta;
      }
      if (direction.includes('s')) {
        newHeight = Math.max(300, startHeight + deltaY);
      }
      if (direction.includes('n')) {
        const heightDelta = Math.min(deltaY, startHeight - 300);
        newHeight = startHeight - heightDelta;
        newY = startPosY + heightDelta;
      }

      setSize({ width: newWidth, height: newHeight });
      setPosition({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [size, position]);

  return (
    <motion.div
      ref={windowRef}
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ 
        scale: 1, 
        opacity: 1,
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      }}
      exit={{ scale: 0.9, opacity: 0 }}
      transition={{ 
        type: "spring", 
        stiffness: 400, 
        damping: 30,
        opacity: { duration: 0.15 }
      }}
      drag={!isMaximized}
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      onDragEnd={handleDragEnd}
      onMouseDown={onFocus}
      style={{ zIndex }}
      className={cn(
        "absolute flex flex-col rounded-2xl overflow-hidden",
        "border border-border",
        isActive ? "shadow-2xl" : "shadow-xl"
      )}
    >
      <div
        onPointerDown={(e) => {
          if (!isMaximized) {
            dragControls.start(e);
          }
        }}
        onDoubleClick={handleMaximize}
        className={cn(
          "flex items-center h-11 px-2.5 gap-3 select-none flex-shrink-0",
          "border-b border-border bg-background/60 backdrop-blur-2xl"
        )}
      >
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="group w-4 h-4 rounded-sm bg-red-500 hover:opacity-80 flex items-center justify-center transition-colors"
          >
            <X className="w-2.5 h-2.5 text-white transition-colors" strokeWidth={2} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMinimize?.();
            }}
            className="group w-4 h-4 rounded-sm bg-yellow-500 hover:opacity-80 flex items-center justify-center transition-colors"
          >
            <Minus className="w-2.5 h-2.5 text-white transition-colors" strokeWidth={2} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMaximize();
            }}
            className="group w-4 h-4 rounded-md bg-green-500 hover:opacity-80 flex items-center justify-center transition-colors"
          >
            <Square className="w-2.5 h-2.5 text-white transition-colors" strokeWidth={2} />
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center gap-2">
          {icon && <div className="w-4 h-4 flex-shrink-0">{icon}</div>}
          <span className="text-[13px] font-semibold truncate text-muted-foreground">
            {title}
          </span>
        </div>

        <div className="w-[52px]" />
      </div>

      <div className="flex-1 overflow-hidden bg-background/60 backdrop-blur-xl">
        {children}
      </div>

      {!isMaximized && (
        <>
          <div 
            className="absolute top-0 left-0 w-2 h-full cursor-ew-resize" 
            onMouseDown={(e) => handleResize(e, 'w')}
          />
          <div 
            className="absolute top-0 right-0 w-2 h-full cursor-ew-resize" 
            onMouseDown={(e) => handleResize(e, 'e')}
          />
          <div 
            className="absolute bottom-0 left-0 w-full h-2 cursor-ns-resize" 
            onMouseDown={(e) => handleResize(e, 's')}
          />
          <div 
            className="absolute top-0 left-0 w-full h-2 cursor-ns-resize" 
            onMouseDown={(e) => handleResize(e, 'n')}
          />
          <div 
            className="absolute top-0 left-0 w-4 h-4 cursor-nwse-resize" 
            onMouseDown={(e) => handleResize(e, 'nw')}
          />
          <div 
            className="absolute top-0 right-0 w-4 h-4 cursor-nesw-resize" 
            onMouseDown={(e) => handleResize(e, 'ne')}
          />
          <div 
            className="absolute bottom-0 left-0 w-4 h-4 cursor-nesw-resize" 
            onMouseDown={(e) => handleResize(e, 'sw')}
          />
          <div 
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize" 
            onMouseDown={(e) => handleResize(e, 'se')}
          />
        </>
      )}
    </motion.div>
  );
});

AppWindow.displayName = 'AppWindow';
