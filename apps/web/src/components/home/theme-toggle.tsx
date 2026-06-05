'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/marketing/button';
import { getThemeById } from '@/lib/themes';
import { cn } from '@/lib/utils';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { MoonStar, SunDim } from 'lucide-react';
import { useTheme } from 'next-themes';
import * as React from 'react';

interface ThemeToggleProps {
  variant?: 'icon' | 'compact';
  className?: string;
}

export function ThemeToggle({ variant = 'icon', className }: ThemeToggleProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const themeId = useUserPreferencesStore((s) => s.preferences.themeId);
  const currentTheme = getThemeById(themeId);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  if (variant === 'compact') {
    return (
      <div className="bg-foreground/10 shadow-custom flex items-center gap-0.5 rounded-sm p-0.5">
        <button
          aria-label="Light theme"
          className="[&amp;&gt;svg]:size-4 text-foreground inline-flex size-7 cursor-pointer items-center justify-center rounded-sm transition-colors duration-150 ease-out"
          style={{ backgroundColor: theme === 'light' ? 'var(--background)' : 'transparent' }}
          type="button"
          onClick={() => setTheme('light')}
        >
          <svg
            aria-hidden="true"
            width="24px"
            height="24px"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M13 2C13 1.44772 12.5523 1 12 1C11.4477 1 11 1.44772 11 2V3C11 3.55228 11.4477 4 12 4C12.5523 4 13 3.55228 13 3V2Z"
              fill="currentColor"
            ></path>
            <path
              d="M13 21C13 20.4477 12.5523 20 12 20C11.4477 20 11 20.4477 11 21V22C11 22.5523 11.4477 23 12 23C12.5523 23 13 22.5523 13 22V21Z"
              fill="currentColor"
            ></path>
            <path
              d="M19.777 4.22295C20.1675 4.61347 20.1675 5.24664 19.777 5.63716L19.0669 6.34716C18.6764 6.73768 18.0433 6.73768 17.6527 6.34716C17.2622 5.95664 17.2622 5.32347 17.6527 4.93295L18.3627 4.22295C18.7533 3.83242 19.3864 3.83242 19.777 4.22295Z"
              fill="currentColor"
            ></path>
            <path
              d="M6.34726 19.0671C6.73779 18.6766 6.73779 18.0434 6.34726 17.6529C5.95674 17.2624 5.32357 17.2624 4.93305 17.6529L4.22305 18.3629C3.83253 18.7534 3.83253 19.3866 4.22305 19.7771C4.61357 20.1676 5.24674 20.1676 5.63726 19.7771L6.34726 19.0671Z"
              fill="currentColor"
            ></path>
            <path
              d="M20 12C20 11.4477 20.4477 11 21 11H22C22.5523 11 23 11.4477 23 12C23 12.5523 22.5523 13 22 13H21C20.4477 13 20 12.5523 20 12Z"
              fill="currentColor"
            ></path>
            <path
              d="M2 11C1.44772 11 1 11.4477 1 12C1 12.5523 1.44772 13 2 13H3C3.55228 13 4 12.5523 4 12C4 11.4477 3.55228 11 3 11H2Z"
              fill="currentColor"
            ></path>
            <path
              d="M17.6527 17.6529C18.0433 17.2624 18.6764 17.2624 19.0669 17.6529L19.777 18.3629C20.1675 18.7534 20.1675 19.3866 19.777 19.7771C19.3864 20.1676 18.7533 20.1676 18.3627 19.7771L17.6527 19.0671C17.2622 18.6766 17.2622 18.0434 17.6527 17.6529Z"
              fill="currentColor"
            ></path>
            <path
              d="M5.63726 4.22295C5.24674 3.83242 4.61357 3.83242 4.22305 4.22295C3.83253 4.61347 3.83253 5.24664 4.22305 5.63716L4.93305 6.34716C5.32357 6.73768 5.95674 6.73768 6.34726 6.34716C6.73779 5.95664 6.73779 5.32347 6.34726 4.93295L5.63726 4.22295Z"
              fill="currentColor"
            ></path>
            <path
              d="M7.75736 7.75736C10.1005 5.41421 13.8995 5.41421 16.2426 7.75736C18.5858 10.1005 18.5858 13.8995 16.2426 16.2426C13.8995 18.5858 10.1005 18.5858 7.75736 16.2426C5.41421 13.8995 5.41421 10.1005 7.75736 7.75736Z"
              fill="currentColor"
            ></path>
          </svg>
        </button>
        <button
          aria-label="Dark theme"
          className="[&amp;&gt;svg]:size-4 hover:text-foreground text-foreground inline-flex size-7 cursor-pointer items-center justify-center rounded-sm transition-colors duration-150 ease-out"
          type="button"
          style={{ backgroundColor: theme === 'dark' ? 'var(--background)' : 'transparent' }}
          onClick={() => setTheme('dark')}
        >
          <svg
            aria-hidden="true"
            width="24px"
            height="24px"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M12.0517 3.59971C12.2712 3.28123 12.2873 2.86472 12.0931 2.53021C11.8989 2.19569 11.5292 2.00315 11.1438 2.03581C6.0214 2.46985 2 6.76372 2 11.9979C2 17.5197 6.47632 21.996 11.9981 21.996C17.2324 21.996 21.5264 17.9745 21.9602 12.8519C21.9929 12.4664 21.8003 12.0968 21.4658 11.9026C21.1313 11.7084 20.7148 11.7246 20.3963 11.9441C19.4302 12.61 18.2602 12.9998 16.9961 12.9998C13.6824 12.9998 10.9961 10.3135 10.9961 6.99976C10.9961 5.73577 11.3858 4.56582 12.0517 3.59971Z"
              fill="currentColor"
            ></path>
          </svg>
        </button>
        <button
          aria-label="System theme"
          className="[&amp;&gt;svg]:size-4 hover:text-foreground text-foreground inline-flex size-7 cursor-pointer items-center justify-center rounded-sm transition-colors duration-150 ease-out"
          type="button"
          style={{ backgroundColor: theme === 'system' ? 'var(--background)' : 'transparent' }}
          onClick={() => setTheme('system')}
        >
          <svg
            aria-hidden="true"
            width="24px"
            height="24px"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M6 3C3.79086 3 2 4.79086 2 7V12H22V7C22 4.79086 20.2091 3 18 3H6Z"
              fill="currentColor"
            ></path>
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M2 14H22C22 16.2091 20.2091 18 18 18H15V21C15 21.5523 14.5523 22 14 22H10C9.44772 22 9 21.5523 9 21V18H6C3.79086 18 2 16.2091 2 14ZM11 18V20H13V18H11Z"
              fill="currentColor"
            ></path>
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="transparent"
        size="icon-sm"
        onClick={() => setTheme(resolvedTheme === 'light' ? 'dark' : 'light')}
        className={cn('cursor-pointer rounded-full', className)}
      >
        <SunDim className="hidden dark:block" />
        <MoonStar className="block dark:hidden" />
        <span className="sr-only">
          {tHardcodedUi.raw('componentsHomeThemeToggle.line93JsxTextToggleTheme')}
        </span>
      </Button>
    </div>
  );
}
