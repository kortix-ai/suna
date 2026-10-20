'use client';

import { Button } from '@kortix/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { MonitorIcon, MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';

/**
 * Light, dark or the system setting, remembered in this browser. The class on
 * <html> is set before the first paint by `THEME_SCRIPT` (layout.tsx), so the
 * page never flashes the other theme.
 */
import { THEME_DEFAULT as DEFAULT, THEME_KEY as KEY, type ThemeChoice } from '@/config/theme-script';

export type { ThemeChoice };

function apply(choice: ThemeChoice) {
  const dark =
    choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function useTheme() {
  const [choice, setState] = useState<ThemeChoice>(DEFAULT);
  useEffect(() => {
    try {
      setState((localStorage.getItem(KEY) as ThemeChoice | null) ?? DEFAULT);
    } catch {
      // Storage blocked: keep the default.
    }
  }, []);
  const setChoice = useCallback((next: ThemeChoice) => {
    setState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    apply(next);
  }, []);
  return { choice, setChoice };
}

const ICONS = { light: SunIcon, dark: MoonIcon, system: MonitorIcon } as const;

/** The theme switch: one icon button, Light / Dark / System. */
export function ThemeMenu() {
  const { choice, setChoice } = useTheme();
  const Icon = ICONS[choice];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Theme">
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup value={choice} onValueChange={(v) => setChoice(v as ThemeChoice)}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
