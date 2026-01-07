import React, { useState, useEffect } from 'react';

const thinkingPhrases = [
  'Brewing ideas',
  'Connecting the dots',
  'Cooking up',
  'Almost there',
  'Spinning up neurons',
  'Piecing it together',
  'Working some magic',
  'Crunching thoughts',
];

export const AgentLoader = () => {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsTransitioning(true);
      setTimeout(() => {
        setPhraseIndex((prev) => (prev + 1) % thinkingPhrases.length);
        setIsTransitioning(false);
      }, 200);
    }, 2800);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex py-2 items-center gap-2.5 w-full">
      {/* Bouncy dots */}
      <div className="flex items-center gap-[5px]">
        <span className="bouncy-dot bouncy-dot-1" />
        <span className="bouncy-dot bouncy-dot-2" />
        <span className="bouncy-dot bouncy-dot-3" />
      </div>

      {/* Fun cycling text */}
      <span 
        className={`text-sm text-muted-foreground whitespace-nowrap thinking-text ${
          isTransitioning ? 'thinking-text-exit' : 'thinking-text-enter'
        }`}
      >
        {thinkingPhrases[phraseIndex]}
      </span>

      <style jsx>{`
        .bouncy-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: currentColor;
          animation: bounce 1s ease-in-out infinite;
        }

        .bouncy-dot-1 { animation-delay: 0ms; }
        .bouncy-dot-2 { animation-delay: 160ms; }
        .bouncy-dot-3 { animation-delay: 320ms; }

        @keyframes bounce {
          0%, 100% {
            transform: translateY(0);
            opacity: 0.4;
          }
          50% {
            transform: translateY(-6px);
            opacity: 1;
          }
        }

        .thinking-text {
          font-size: 14px;
          background: linear-gradient(
            90deg,
            currentColor 0%,
            currentColor 25%,
            rgba(255, 255, 255, 0.55) 50%,
            currentColor 75%,
            currentColor 100%
          );
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: shimmerFlow 1.8s linear infinite;
          transition: opacity 0.2s ease, transform 0.2s ease;
        }

        .thinking-text-enter {
          opacity: 1;
          transform: translateY(0);
        }

        .thinking-text-exit {
          opacity: 0;
          transform: translateY(-4px);
        }

        @keyframes shimmerFlow {
          0% { background-position: 200% center; }
          100% { background-position: -200% center; }
        }
      `}</style>
    </div>
  );
};
