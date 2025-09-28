'use client';

import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useScroll } from 'motion/react';
import { FlickeringGrid } from '@/components/home/ui/flickering-grid';
import { useMediaQuery } from '@/hooks/use-media-query';

export default function NotFound() {
  const tablet = useMediaQuery('(max-width: 1024px)');
  const [mounted, setMounted] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeout = useRef<NodeJS.Timeout | null>(null);
  const { scrollY } = useScroll();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Detect when scrolling is active to reduce animation complexity
  useEffect(() => {
    const unsubscribe = scrollY.on('change', () => {
      setIsScrolling(true);

      // Clear any existing timeout
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }

      // Set a new timeout
      scrollTimeout.current = setTimeout(() => {
        setIsScrolling(false);
      }, 300); // Wait 300ms after scroll stops
    });

    return () => {
      unsubscribe();
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }
    };
  }, [scrollY]);

  return (
    <section className="w-full relative overflow-hidden min-h-screen flex items-center justify-center">
      <div className="relative flex flex-col items-center w-full px-6">
        {/* Left side flickering grid with gradient fades */}
        <div className="absolute left-0 top-0 h-full w-1/3 -z-10 overflow-hidden">
          {/* Horizontal fade from left to right */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-background z-10" />

          {/* Vertical fade from top */}
          <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-background via-background/90 to-transparent z-10" />

          {/* Vertical fade to bottom */}
          <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-background via-background/90 to-transparent z-10" />

          <FlickeringGrid
            className="h-full w-full"
            squareSize={mounted && tablet ? 2 : 2.5}
            gridGap={mounted && tablet ? 2 : 2.5}
            color="var(--secondary)"
            maxOpacity={0.4}
            flickerChance={isScrolling ? 0.01 : 0.03}
          />
        </div>

        {/* Right side flickering grid with gradient fades */}
        <div className="absolute right-0 top-0 h-full w-1/3 -z-10 overflow-hidden">
          {/* Horizontal fade from right to left */}
          <div className="absolute inset-0 bg-gradient-to-l from-transparent via-transparent to-background z-10" />

          {/* Vertical fade from top */}
          <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-background via-background/90 to-transparent z-10" />

          {/* Vertical fade to bottom */}
          <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-background via-background/90 to-transparent z-10" />

          <FlickeringGrid
            className="h-full w-full"
            squareSize={mounted && tablet ? 2 : 2.5}
            gridGap={mounted && tablet ? 2 : 2.5}
            color="var(--secondary)"
            maxOpacity={0.4}
            flickerChance={isScrolling ? 0.01 : 0.03}
          />
        </div>

        {/* Center content background with rounded bottom */}
        <div className="absolute inset-x-1/4 top-0 h-full -z-20 bg-background rounded-b-xl"></div>

        <div className="relative z-10 max-w-3xl mx-auto h-full w-full flex flex-col gap-10 items-center justify-center">
          <div className="inline-flex h-10 w-fit items-center justify-center gap-2 rounded-full bg-secondary/10 text-secondary px-4">
            <span className="text-sm font-medium">404 Error</span>
          </div>

          <div className="flex flex-col items-center justify-center gap-5">
            <h1 className="text-3xl md:text-4xl lg:text-5xl xl:text-6xl font-medium tracking-tighter text-balance text-center text-primary">
              Page not found
            </h1>
            <p className="text-base md:text-lg text-center text-muted-foreground font-medium text-balance leading-relaxed tracking-tight">
              The page you're looking for doesn't exist or has been moved.
            </p>
          </div>
          <div className="flex items-center w-full max-w-xl gap-2 flex-wrap justify-center">
            <Link
              href="/"
              className="inline-flex h-12 md:h-14 items-center justify-center gap-2 rounded-full bg-primary text-white px-6 shadow-md hover:bg-primary/90 transition-all duration-200"
            >
              <ArrowLeft className="size-4 md:size-5 dark:text-black" />
              <span className="font-medium dark:text-black">Return Home</span>
            </Link>
          </div>

          {/* Subtle glow effect */}
          <div className="absolute -bottom-4 inset-x-0 h-6 bg-secondary/20 blur-xl rounded-full -z-10 opacity-70"></div>
        </div>
      </div>
    </section>
  );
}
