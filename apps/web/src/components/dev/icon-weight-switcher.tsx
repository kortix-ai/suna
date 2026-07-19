'use client';

import { useIconWeight } from '@/components/ui/icon-provider';
import { ICON_WEIGHTS } from '@/lib/icons/icon-config';
import { cn } from '@/lib/utils';

/* Dev-only tool: flips the app-wide phosphor weight live (persisted to
   localStorage). Rendered from the root layout behind a NODE_ENV check. */
export function IconWeightSwitcher() {
  const { weight, setWeight } = useIconWeight();

  return (
    <div
      role="group"
      aria-label="Icon weight"
      className="bg-background fixed bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-md border p-1 shadow-md"
    >
      {ICON_WEIGHTS.map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={w === weight}
          onClick={() => setWeight(w)}
          className={cn(
            'rounded-sm px-1.5 py-0.5 text-[10px] font-medium capitalize transition-colors',
            w === weight
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
