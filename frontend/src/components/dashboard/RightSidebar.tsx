"use client";
import React from "react";
import { X, Minimize2 } from "lucide-react";

interface RightSidebarProps {
  isCollapsed: boolean;
  panelTitle: string;
  panelContent: React.ReactNode;
  toggleSidebar: () => void;
  toggleVisibility: () => void;
}

export default function RightSidebar({
  isCollapsed,
  panelTitle,
  panelContent,
  toggleSidebar,
  toggleVisibility
}: RightSidebarProps) {
  return (
    <div
      className={`h-screen border-l border-subtle dark:border-white/10 bg-background transition-all duration-300 ease-in-out rounded-l-xl shadow-custom ${
        isCollapsed
          ? "w-0 opacity-0 p-0 m-0 border-0"
          : "w-[40%] opacity-100 flex-shrink-0"
      } overflow-hidden`}
      style={{ 
        backdropFilter: "blur(8px)",
        zIndex: 20
      }}
    >
      <div className="h-12 p-2 flex items-center justify-between rounded-t-xl">
        <h2 className="font-medium text-sm text-card-title">
          {panelTitle}
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleSidebar}
            className="p-1 hover:bg-hover-bg text-foreground/60 transition-all duration-200"
            aria-label="Collapse sidebar"
          >
            <Minimize2 size={14} />
          </button>
          <button
            onClick={toggleVisibility}
            className="p-1 hover:bg-hover-bg text-foreground/60 transition-all duration-200"
            aria-label="Close sidebar"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="p-3 overflow-y-auto h-[calc(100vh-48px)]">
        {panelContent || (
          <div className="flex flex-col items-center justify-center h-full text-foreground/40">
            <p className="text-sm">No content selected</p>
          </div>
        )}
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