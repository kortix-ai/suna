'use client';

import React, { useState, useEffect, memo } from 'react';
import { KortixLoader } from '@/components/ui/kortix-loader';

interface StreamingLoaderProps {
  message?: string;
  className?: string;
}

export const StreamingLoader = memo(function StreamingLoader({
  message,
  className,
}: StreamingLoaderProps) {
  const [dots, setDots] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className={`flex items-center justify-center h-full w-full ${className || ''}`}>
      <div className="flex flex-col items-center gap-4">
        <KortixLoader customSize={32} speed={1} />
        <span className="text-sm text-muted-foreground">
          {message || 'Generating content'}{dots}
        </span>
      </div>
    </div>
  );
});

StreamingLoader.displayName = 'StreamingLoader';

