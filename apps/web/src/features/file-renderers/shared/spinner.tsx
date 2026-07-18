'use client';

import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-center', className)}>
      <KortixLoader customSize={16} />
    </span>
  );
}
