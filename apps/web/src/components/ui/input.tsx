// import * as React from 'react';

// import { cn } from '@/lib/utils';

// function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
//   return (
//     <input
//       type={type}
//       data-slot="input"
//       className={cn(
//         'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex h-11 w-full min-w-0 rounded-2xl border bg-card px-3 py-1 text-sm font-medium transition-[color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
//         'focus:outline-none focus:ring-2 focus:ring-primary/50',
//         'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
//         className,
//       )}
//       // Suppress hydration warnings for attributes injected by browser extensions
//       // (e.g., password managers, form fillers) before React hydration
//       suppressHydrationWarning
//       {...props}
//     />
//   );
// }

// export { Input };

import { cn } from '@/lib/utils';
import * as React from 'react';

type InputProps = Omit<React.ComponentProps<'input'>, 'size'> & {
  variant?: 'default' | 'secondary';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
};

function Input({ className, type, variant = 'default', size = 'sm', ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'border-border bg-input text-foreground file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex h-10 w-full min-w-0 rounded-md border px-3 py-1 text-sm font-medium transition-[color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus:ring-primary/50 focus:ring-1 focus:outline-none',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        type === 'search' &&
          '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none',
        type === 'file' &&
          'text-muted-foreground/70 file:border-input file:text-foreground p-0 pr-3 italic file:me-3 file:h-full file:border-0 file:border-r file:border-solid file:bg-transparent file:px-3 file:text-sm file:font-medium file:not-italic',
        variant === 'secondary' && 'bg-input text-secondary-foreground border-none',
        size === 'xs' && 'h-8 text-xs',
        size === 'sm' && 'h-9 text-sm',
        size === 'md' && 'h-10 text-sm',
        size === 'lg' && 'h-11 text-base',
        size === 'xl' && 'h-12 text-lg',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
