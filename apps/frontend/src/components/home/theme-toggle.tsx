'use client';

import * as React from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface ThemeToggleProps {
  variant?: 'icon' | 'compact';
}

export function ThemeToggle({ variant = 'icon' }: ThemeToggleProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return variant === 'compact' ? (
      <div className="h-7 w-[72px] animate-pulse bg-muted/50 rounded-md" />
    ) : (
      <div className="h-8 w-8 animate-pulse bg-muted/50 rounded-full" />
    );
  }

  if (variant === 'compact') {
    return (
      <Select value={theme} onValueChange={setTheme}>
        <SelectTrigger
          size="sm"
          className="h-7 px-2.5 w-fit min-w-[72px] border-0 bg-transparent hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 text-muted-foreground/60 transition-all duration-200 shadow-none"
        >
          <div className="flex items-center gap-1.5">
            {resolvedTheme === 'dark' ? (
              <Moon className="size-3.5" />
            ) : (
              <Sun className="size-3.5" />
            )}
            <SelectValue>
              {theme === 'system' ? 'Auto' : theme === 'dark' ? 'Dark' : 'Light'}
            </SelectValue>
          </div>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="light">
            <div className="flex items-center gap-2">
              <Sun className="size-3.5" />
              <span>Light</span>
            </div>
          </SelectItem>
          <SelectItem value="dark">
            <div className="flex items-center gap-2">
              <Moon className="size-3.5" />
              <span>Dark</span>
            </div>
          </SelectItem>
          <SelectItem value="system">
            <div className="flex items-center gap-2">
              <Monitor className="size-3.5" />
              <span>Auto</span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    );
  }

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => setTheme(resolvedTheme === 'light' ? 'dark' : 'light')}
      className="cursor-pointer rounded-full h-8 w-8"
    >
      <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0 text-primary" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100 text-primary" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
