import React, { memo } from "react";

interface MeshGradientLoaderProps {
  variant?: "ask" | "complete";
  className?: string;
}

export const MeshGradientLoader = memo(function MeshGradientLoader({
  variant = "ask",
  className = "",
}: MeshGradientLoaderProps) {
  const label = variant === "complete" ? "Completing..." : "Asking...";
  
  return (
    <div className="flex items-center gap-1.5">
      <div 
        className={`w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin opacity-60 ${className}`} 
      />
      <span className="text-xs font-medium text-muted-foreground animate-shimmer-text">
        {label}
      </span>
    </div>
  );
});

export default MeshGradientLoader;
