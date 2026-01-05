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
  
  const gradient = "linear-gradient(135deg, #22c55e 0%, #10b981 25%, #3b82f6 50%, #8b5cf6 75%, #22c55e 100%)"
  return (
    <div className="flex items-center gap-1.5">
      <div 
        className={`w-3.5 h-3.5 rounded-full animate-[mesh-orb-spin_2s_linear_infinite,mesh-orb-gradient_3s_ease_infinite] ${className}`} 
        style={{ backgroundImage: gradient, backgroundSize: '300% 300%' }} 
      />
      <span className="text-xs font-medium text-muted-foreground animate-shimmer-text">
        {label}
      </span>
    </div>
  );
});

export default MeshGradientLoader;
