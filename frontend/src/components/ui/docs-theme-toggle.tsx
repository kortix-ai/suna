'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DocsThemeToggleProps extends React.HTMLAttributes<HTMLButtonElement> {
  size?: 'sm' | 'default' | 'lg';
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
}

export const DocsThemeToggle = React.forwardRef<HTMLButtonElement, DocsThemeToggleProps>(
  ({ size = 'sm', variant = 'ghost', className, ...props }, ref) => {
    const { theme, setTheme } = useTheme();

    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        className={cn("h-8 w-8 p-0", className)}
        {...props}
      >
        <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        <span className="sr-only">Toggle theme</span>
      </Button>
    );
  }
);

DocsThemeToggle.displayName = 'DocsThemeToggle'; 