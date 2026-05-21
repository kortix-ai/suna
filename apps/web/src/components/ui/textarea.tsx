import * as React from 'react';

import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // Shares ONE treatment with Input + Select: bg-card surface, border,
        // rounded-2xl, accent focus ring, no shadow. Keep these in sync.
        'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex field-sizing-content min-h-16 w-full rounded-2xl border bg-card px-3 py-2 text-sm font-medium transition-[color] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus:outline-none focus:ring-2 focus:ring-primary/50',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className,
      )}
      // Suppress hydration warnings for attributes injected by browser extensions
      // (e.g., password managers, form fillers) before React hydration
      suppressHydrationWarning
      {...props}
    />
  );
}

export { Textarea };
