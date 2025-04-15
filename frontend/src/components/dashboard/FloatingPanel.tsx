"use client";
import React, { useRef, useState, useEffect, useCallback } from "react";
import { X, Maximize2, GripHorizontal } from "lucide-react";

interface FloatingPanelProps {
  title: string;
  position: { x: number; y: number };
  setPosition: (position: { x: number; y: number }) => void;
  toggleSidebar: () => void;
  toggleVisibility: () => void;
}

export default function FloatingPanel({
  title,
  position,
  setPosition,
  toggleSidebar,
  toggleVisibility
}: FloatingPanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const floatingPanelRef = useRef<HTMLDivElement>(null);

  // Dragging functionality
  const handleMouseDown = (e: React.MouseEvent) => {
    if (
      !(e.target as HTMLElement).closest(".drag-handle") ||
      (e.target as HTMLElement).closest("button")
    ) {
      return;
    }

    e.preventDefault();
    setIsDragging(true);

    const rect = floatingPanelRef.current?.getBoundingClientRect();
    if (rect) {
      setDragStart({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !floatingPanelRef.current) return;

      e.preventDefault();
      const mainContent = document.querySelector(".main-content-area");
      if (!mainContent) return;

      const mainRect = mainContent.getBoundingClientRect();
      const panelRect = floatingPanelRef.current.getBoundingClientRect();

      let newX = e.clientX - dragStart.x - mainRect.left;
      let newY = e.clientY - dragStart.y - mainRect.top;

      // Constrain within bounds
      newX = Math.max(0, Math.min(newX, mainRect.width - panelRect.width));
      newY = Math.max(0, Math.min(newY, mainRect.height - panelRect.height));

      setPosition({ x: newX, y: newY });
    },
    [isDragging, dragStart, setPosition]
  );

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Add and remove event listeners
  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, handleMouseMove]);

  return (
    <div
      ref={floatingPanelRef}
      className={`absolute bg-background border border-subtle dark:border-white/10 rounded-lg shadow-custom flex flex-col w-72 overflow-hidden ${
        isDragging ? "cursor-grabbing" : ""
      }`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        backdropFilter: "blur(8px)",
        zIndex: 50,
      }}
      onMouseDown={handleMouseDown}
    >
      <div className="p-2 flex items-center justify-between drag-handle cursor-grab">
        <div className="flex items-center gap-1.5">
          <GripHorizontal
            size={12}
            className="text-icon-color"
          />
          <h3 className="font-medium text-foreground text-xs select-none">
            {title}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleSidebar}
            className="p-1 rounded-full hover:bg-hover-bg text-foreground/60 transition-all duration-200"
            aria-label="Expand panel"
          >
            <Maximize2 size={12} />
          </button>
          <button
            onClick={toggleVisibility}
            className="p-1 rounded-full hover:bg-hover-bg text-foreground/60 transition-all duration-200"
            aria-label="Close panel"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="p-3 max-h-60 overflow-y-auto">
        <div className="flex flex-col items-center justify-center py-4 text-foreground/40">
          <p className="mb-2 select-none text-xs">Content minimized</p>
          <button
            onClick={toggleSidebar}
            className="px-2 py-1 rounded-md text-primary text-xs"
          >
            Expand
          </button>
        </div>
      </div>
      <div
        className="absolute inset-x-0 bottom-0 h-[40%] pointer-events-none bg-gradient-overlay"
        style={{
          opacity: 0.4,
          mixBlendMode: "multiply",
        }}
      />
    </div>
  );
} 