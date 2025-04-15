"use client";
import React from "react";

interface MainContentProps {
  children: React.ReactNode;
  leftSidebarCollapsed: boolean;
  rightSidebarCollapsed: boolean;
  showRightSidebar: boolean;
  showFloatingPanel: boolean;
  renderFloatingPanel?: () => React.ReactNode;
}

export default function MainContent({
  children,
  leftSidebarCollapsed,
  rightSidebarCollapsed,
  showRightSidebar,
  showFloatingPanel,
  renderFloatingPanel
}: MainContentProps) {
  return (
    <div 
      className="flex flex-col h-full overflow-hidden bg-background-secondary transition-all duration-300 ease-in-out rounded-l-xl shadow-sm border-l border-subtle dark:border-white/10"
      style={{ 
        backdropFilter: "blur(8px)",
        zIndex: 10
      }}
    >
      <div className="flex-1 overflow-y-auto bg-transparent main-content-area relative">
        <div
          className={`mx-auto p-4 transition-all duration-300 ${
            // Increase container width when sidebars are collapsed
            leftSidebarCollapsed &&
            (rightSidebarCollapsed || !showRightSidebar)
              ? "container max-w-[95%]"
              : "container"
          }`}
        >
          {children}
        </div>

        {/* Floating panel rendered here if needed */}
        {showFloatingPanel && renderFloatingPanel && renderFloatingPanel()}
      </div>
    </div>
  );
} 