'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/marketing/button';
import { getThemeById } from '@/lib/themes';
import { cn } from '@/lib/utils';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { MoonStarsIcon as MoonStar, SunDimIcon as SunDim } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import * as React from 'react';

interface ThemeToggleProps {
  variant?: 'icon' | 'compact';
  className?: string;
  systemTheme?: boolean;
}

export function ThemeToggle({ variant = 'icon', className, systemTheme = true }: ThemeToggleProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const themeId = useUserPreferencesStore((s) => s.preferences.themeId);
  const currentTheme = getThemeById(themeId);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (variant === 'compact') {
    // Intentional mount gate: `theme` is client-only (next-themes), and the
    // active-segment highlight below reads it during render. Rendering before
    // mount would hydrate with no segment highlighted and then flash the
    // correct one. The icon variant below renders nothing theme-dependent
    // (CSS `dark:` classes swap the icon), so it is NOT gated and never
    // flickers.
    if (!mounted) {
      return null;
    }
    return (
      <div className="bg-foreground/10 shadow-custom flex items-center gap-0.5 rounded-sm p-0.5">
        <button
          aria-label={tI18nHardcoded.raw(
            'autoComponentsHomeThemeToggleJsxAttrAriaLabelLightTheme26963d69',
          )}
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
              d="M13 2C13 1.45 12.55 1 12 1C11.45 1 11 1.45 11 2V3C11 3.55 11.45 4 12 4C12.55 4 13 3.55 13 3V2Z"
              fill="currentColor"
            ></path>
            <path
              d="M13 21C13 20.45 12.55 20 12 20C11.45 20 11 20.45 11 21V22C11 22.55 11.45 23 12 23C12.55 23 13 22.55 13 22V21Z"
              fill="currentColor"
            ></path>
            <path
              d="M19.78 4.22C20.17 4.61 20.17 5.25 19.78 5.64L19.07 6.35C18.68 6.74 18.04 6.74 17.65 6.35C17.26 5.96 17.26 5.32 17.65 4.93L18.36 4.22C18.75 3.83 19.39 3.83 19.78 4.22Z"
              fill="currentColor"
            ></path>
            <path
              d="M6.35 19.07C6.74 18.68 6.74 18.04 6.35 17.65C5.96 17.26 5.32 17.26 4.93 17.65L4.22 18.36C3.83 18.75 3.83 19.39 4.22 19.78C4.61 20.17 5.25 20.17 5.64 19.78L6.35 19.07Z"
              fill="currentColor"
            ></path>
            <path
              d="M20 12C20 11.45 20.45 11 21 11H22C22.55 11 23 11.45 23 12C23 12.55 22.55 13 22 13H21C20.45 13 20 12.55 20 12Z"
              fill="currentColor"
            ></path>
            <path
              d="M2 11C1.45 11 1 11.45 1 12C1 12.55 1.45 13 2 13H3C3.55 13 4 12.55 4 12C4 11.45 3.55 11 3 11H2Z"
              fill="currentColor"
            ></path>
            <path
              d="M17.65 17.65C18.04 17.26 18.68 17.26 19.07 17.65L19.78 18.36C20.17 18.75 20.17 19.39 19.78 19.78C19.39 20.17 18.75 20.17 18.36 19.78L17.65 19.07C17.26 18.68 17.26 18.04 17.65 17.65Z"
              fill="currentColor"
            ></path>
            <path
              d="M5.64 4.22C5.25 3.83 4.61 3.83 4.22 4.22C3.83 4.61 3.83 5.25 4.22 5.64L4.93 6.35C5.32 6.74 5.96 6.74 6.35 6.35C6.74 5.96 6.74 5.32 6.35 4.93L5.64 4.22Z"
              fill="currentColor"
            ></path>
            <path
              d="M7.76 7.76C10.1 5.41 13.9 5.41 16.24 7.76C18.59 10.1 18.59 13.9 16.24 16.24C13.9 18.59 10.1 18.59 7.76 16.24C5.41 13.9 5.41 10.1 7.76 7.76Z"
              fill="currentColor"
            ></path>
          </svg>
        </button>
        <button
          aria-label={tI18nHardcoded.raw(
            'autoComponentsHomeThemeToggleJsxAttrAriaLabelDarkThemebf1de1f0',
          )}
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
              d="M12.05 3.6C12.27 3.28 12.29 2.86 12.09 2.53C11.9 2.2 11.53 2 11.14 2.04C6.02 2.47 2 6.76 2 12C2 17.52 6.48 22 12 22C17.23 22 21.53 17.97 21.96 12.85C21.99 12.47 21.8 12.1 21.47 11.9C21.13 11.71 20.71 11.72 20.4 11.94C19.43 12.61 18.26 13 17 13C13.68 13 11 10.31 11 7C11 5.74 11.39 4.57 12.05 3.6Z"
              fill="currentColor"
            ></path>
          </svg>
        </button>
        {systemTheme && (
          <button
            aria-label={tI18nHardcoded.raw(
              'autoComponentsHomeThemeToggleJsxAttrAriaLabelSystemThemeb9e760e3',
            )}
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
                d="M6 3C3.79 3 2 4.79 2 7V12H22V7C22 4.79 20.21 3 18 3H6Z"
                fill="currentColor"
              ></path>
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M2 14H22C22 16.21 20.21 18 18 18H15V21C15 21.55 14.55 22 14 22H10C9.45 22 9 21.55 9 21V18H6C3.79 18 2 16.21 2 14ZM11 18V20H13V18H11Z"
                fill="currentColor"
              ></path>
            </svg>
          </button>
        )}
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
