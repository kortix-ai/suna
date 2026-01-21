'use client';

import { memo, useState, useRef, useCallback } from 'react';
import { motion, useDragControls, PanInfo } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Minus, Square, X } from 'lucide-react';

export const DESKTOP_HEADER_HEIGHT = 36;
export const DESKTOP_DOCK_HEIGHT = 68;
export const DESKTOP_PADDING = 4;

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
      const containerHeight = window.innerHeight - DESKTOP_HEADER_HEIGHT;
      const usableHeight = containerHeight - DESKTOP_DOCK_HEIGHT - (DESKTOP_PADDING * 2);
      const usableWidth = window.innerWidth - (DESKTOP_PADDING * 2);
      setPosition({ x: DESKTOP_PADDING, y: DESKTOP_PADDING });
      setSize({ 
        width: usableWidth, 
        height: usableHeight 
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
        "absolute flex flex-col rounded-xl overflow-hidden",
        "border border-border/60",
        isActive ? "shadow-2xl shadow-black/20" : "shadow-xl shadow-black/10"
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
          "flex items-center h-9 px-2.5 gap-2 select-none flex-shrink-0",
          "border-b border-border/50 bg-background/80 backdrop-blur-2xl"
        )}
      >
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="group w-3 h-3 rounded-full bg-[#ff5f57] hover:bg-[#ff5f57]/80 flex items-center justify-center transition-all"
          >
            <X className="w-2 h-2 text-[#ff5f57] group-hover:text-red-900 transition-colors opacity-0 group-hover:opacity-100" strokeWidth={2.5} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMinimize?.();
            }}
            className="group w-3 h-3 rounded-full bg-[#febc2e] hover:bg-[#febc2e]/80 flex items-center justify-center transition-all"
          >
            <Minus className="w-2 h-2 text-[#febc2e] group-hover:text-yellow-900 transition-colors opacity-0 group-hover:opacity-100" strokeWidth={2.5} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMaximize();
            }}
            className="group w-3 h-3 rounded-full bg-[#28c840] hover:bg-[#28c840]/80 flex items-center justify-center transition-all"
          >
            <Square className="w-1.5 h-1.5 text-[#28c840] group-hover:text-green-900 transition-colors opacity-0 group-hover:opacity-100" strokeWidth={2.5} />
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center gap-1.5">
          {icon && <div className="w-3.5 h-3.5 flex-shrink-0">{icon}</div>}
          <span className="text-xs font-medium truncate text-muted-foreground">
            {title}
          </span>
        </div>

        <div className="w-[44px]" />
      </div>

      <div className="flex-1 overflow-hidden bg-background/95 backdrop-blur-2xl">
        {children}
      </div>

      {!isMaximized && (
        <>
          <div 
            className="absolute top-0 left-0 w-2 h-full cursor-ew-resize z-[100] pointer-events-auto" 
            onMouseDown={(e) => handleResize(e, 'w')}
          />
          <div 
            className="absolute top-0 right-0 w-2 h-full cursor-ew-resize z-[100] pointer-events-auto" 
            onMouseDown={(e) => handleResize(e, 'e')}
          />
          <div 
            className="absolute bottom-0 left-0 w-full h-2 cursor-ns-resize z-[100] pointer-events-auto" 
            onMouseDown={(e) => handleResize(e, 's')}
          />
          <div 
            className="absolute top-0 left-0 w-full h-2 cursor-ns-resize z-[100] pointer-events-auto" 
            onMouseDown={(e) => handleResize(e, 'n')}
          />
          <div 
            className="absolute top-0 left-0 w-4 h-4 cursor-nwse-resize z-[100] pointer-events-auto" 
            onMouseDown={(e) => handleResize(e, 'nw')}
          />
          <div 
            className="absolute top-0 right-0 w-4 h-4 cursor-nesw-resize z-[100] pointer-events-auto" 
            onMouseDown={(e) => handleResize(e, 'ne')}
          />
          <div 
            className="absolute bottom-0 left-0 w-4 h-4 cursor-nesw-resize z-[100] pointer-events-auto" 
            onMouseDown={(e) => handleResize(e, 'sw')}
          />
          <div 
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-[100] pointer-events-auto" 
            onMouseDown={(e) => handleResize(e, 'se')}
          />
        </>
      )}
    </motion.div>
  );
});

AppWindow.displayName = 'AppWindow';
