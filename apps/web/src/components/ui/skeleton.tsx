import { cn } from '@/lib/utils';
import * as React from 'react';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'bg-primary/10 relative animate-pulse overflow-hidden rounded-md py-4',
        className,
      )}
    >
      {props.children}
    </div>
  );
}

export { Skeleton };
