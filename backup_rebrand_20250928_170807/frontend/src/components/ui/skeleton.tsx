'use client';

import { cn } from '@/lib/utils';
import React from 'react';

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md',
        'bg-gradient-to-r from-primary/10 via-primary/5 to-primary/10',
        'background-animate',
        className,
      )}
      {...props}
    >
      <div className="shimmer-wrapper">
        <div className="shimmer"></div>
      </div>
      <style jsx>{`
        .background-animate {
          background-size: 200% 200%;
          animation: gradientAnimation 1s ease infinite;
        }

        @keyframes gradientAnimation {
          0% {
            background-position: 0% 50%;
          }
          50% {
            background-position: 100% 50%;
          }
          100% {
            background-position: 0% 50%;
          }
        }

        .shimmer-wrapper {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }

        .shimmer {
          width: 50%;
          height: 100%;
          background: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0) 0%,
            rgba(255, 255, 255, 0.3) 50%,
            rgba(255, 255, 255, 0) 100%
          );
          animation: shimmerAnimation 1s infinite;
          position: absolute;
          top: 0;
          left: -150%;
        }

        @keyframes shimmerAnimation {
          to {
            left: 150%;
          }
        }
      `}</style>
    </div>
  );
}

export { Skeleton };
