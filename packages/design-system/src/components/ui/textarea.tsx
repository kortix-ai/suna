import * as React from 'react';

import { cn } from '../../lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-20 w-full rounded-xl border border-input bg-background px-4 py-2.5 font-sans text-sm transition-colors outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-foreground/[0.03]',
        'focus:border-foreground/30 focus-visible:border-foreground/30',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
