'use client';

import { InteractiveDemo } from '@/components/home/interactive-demo';
import { cn } from '@/lib/utils';

export function DesktopDemo({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'border-card bg-background relative aspect-video h-[min(72vh,520px)] w-full overflow-hidden rounded-[calc(var(--radius)+2px)] border-4 md:h-full',
        className,
      )}
    >
      <InteractiveDemo
        gradientbg={false}
        tab={false}
        embedded
        aside
        activePage="home"
        className="h-full w-full max-w-full"
        contentClassName="max-w-full mx-0 h-full p-0 md:p-0 lg:p-0"
        innerClassName="h-full min-h-0 rounded-none border-none bg-card shadow-none"
        parentClassName="h-full min-h-0"
      />
    </div>
  );
}
