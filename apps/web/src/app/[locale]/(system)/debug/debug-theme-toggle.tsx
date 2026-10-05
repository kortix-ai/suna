'use client';

import { useTheme } from 'next-themes';
import { useEffect } from 'react';

import { ThemeToggle } from '@/components/home/theme-toggle';

// Above the dialog z-ladder (overlays start at 9998) so it stays visible while
// modals are stacked; below the /debug/modal-stack inspector.
const TOGGLE_Z = 2147482000;

// Keys typed here belong to the control: text entry, select typeahead, menus.
const KEY_OWNER_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="menu"]';

function ownsKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEY_OWNER_SELECTOR) !== null;
}

/**
 * Theme control on every /debug page. A click cannot reach it while a modal is
 * open — Radix sets `pointer-events: none` on `body` and treats the click as a
 * backdrop dismiss — so `D` flips light/dark without closing the stack.
 */
export function DebugThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'd') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (ownsKeys(event.target)) return;
      setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [resolvedTheme, setTheme]);

  return (
    <div
      data-testid="debug-theme-toggle"
      className="bg-popover fixed bottom-4 left-4 flex items-center gap-2 rounded-md border py-1 pr-1 pl-3 shadow-md"
      style={{ zIndex: TOGGLE_Z }}
    >
      <span className="text-muted-foreground text-xs">
        Theme · <kbd className="bg-muted text-foreground rounded-sm px-1 font-mono text-xs">D</kbd>
      </span>
      <ThemeToggle variant="compact" />
    </div>
  );
}
