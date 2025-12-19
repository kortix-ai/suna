import React from 'react';

export const AgentLoader = () => {
  return (
    <div className="flex py-2 items-center w-full">
      <span className="text-sm text-muted-foreground whitespace-nowrap animate-shimmer-text">
        Thinking
      </span>
      <style jsx>{`
        .animate-shimmer-text {
          font-size: 14px;
          background: linear-gradient(
            90deg,
            currentColor 0%,
            currentColor 40%,
            rgba(128, 128, 128, 0.5) 50%,
            currentColor 60%,
            currentColor 100%
          );
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: textShimmer 2s ease-in-out infinite;
        }
        @keyframes textShimmer {
          0% { background-position: 100% 0; }
          100% { background-position: -100% 0; }
        }
      `}</style>
    </div>
  );
};

