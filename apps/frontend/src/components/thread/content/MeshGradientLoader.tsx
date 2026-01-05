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
    <div className="flex items-center gap-2">
      <div 
        className={`mesh-loader-orb ${className}`}
        style={{ background: gradient }}
      />
      <span className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
    </div>
  );
});

export default MeshGradientLoader;
