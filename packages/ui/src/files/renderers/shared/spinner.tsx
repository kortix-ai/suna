'use client';

import { KortixLoader } from '../../../primitives/kortix-loader';
import { cn } from '../../../lib/utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-center', className)}>
      <KortixLoader customSize={16} />
    </span>
  );
}
