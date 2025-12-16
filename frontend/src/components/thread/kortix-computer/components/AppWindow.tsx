'use client';

import { memo, useState, useRef, useCallback, useEffect } from 'react';
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
      style={{ 
        zIndex,
        transformOrigin: 'center center',
        boxShadow: isActive 
          ? '0 25px 50px -12px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.1) inset' 
          : '0 10px 40px -10px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.1) inset'
      }}
      className={cn(
        "absolute flex flex-col rounded-2xl overflow-hidden",
        "backdrop-blur-2xl backdrop-saturate-150",
        "border border-neutral-300/20"
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
          "flex items-center h-9 px-2.5 gap-3 select-none flex-shrink-0",
          "border-b border-black/5",
          isActive ? "bg-background" : "bg-background"
        )}
      >
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="group w-6 h-6 rounded-md bg-muted hover:bg-destructive/20 flex items-center justify-center transition-colors"
          >
            <X className="w-3.5 h-3.5 text-muted-foreground group-hover:text-destructive transition-colors" strokeWidth={2} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMinimize?.();
            }}
            className="group w-6 h-6 rounded-md bg-muted hover:bg-muted-foreground/20 flex items-center justify-center transition-colors"
          >
            <Minus className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground transition-colors" strokeWidth={2} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleMaximize();
            }}
            className="group w-6 h-6 rounded-md bg-muted hover:bg-muted-foreground/20 flex items-center justify-center transition-colors"
          >
            <Square className="w-3 h-3 text-muted-foreground group-hover:text-foreground transition-colors" strokeWidth={2} />
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center gap-2">
          {icon && <div className="w-4 h-4 flex-shrink-0">{icon}</div>}
          <span className={cn(
            "text-[13px] font-semibold truncate text-muted-foreground",
          )}>
            {title}
          </span>
        </div>

        <div className="w-[52px]" />
      </div>

      <div className="flex-1 overflow-hidden bg-background">
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
