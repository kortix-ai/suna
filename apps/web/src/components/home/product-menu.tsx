'use client';

import { marketingButtonVariants } from '@/components/ui/marketing/button';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import type { NavMenu } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/**
 * Radix keys its menu state and generated ids off this value. Both the Product
 * and Company menus previously hardcoded 'product', so two independent
 * NavigationMenu roots on the same page produced colliding ids — which React
 * reported as a hydration mismatch inside the trigger on every route. Derive it
 * from the menu's own name so each root is distinct.
 */
const menuValue = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

interface ProductMenuProps {
  name: string;
  menu: NavMenu;
  isNavActive: (href: string) => boolean;
}

/**
 * Desktop hover menu, shared by Product and Company. Radix NavigationMenu gives
 * hover-open, Escape and focus-outside dismissal for free; the controlled
 * `value` adds open-on-focus so the menu is reachable with Tab alone.
 *
 * Panel width follows the column count, so a five-link list does not open a
 * half-viewport panel.
 */
export function ProductMenu({ name, menu, isNavActive }: ProductMenuProps) {
  const MENU_VALUE = menuValue(name);
  const [value, setValue] = useState('');
  const isOpenRef = useRef(false);
  const skipFocusOpenRef = useRef(false);
  const hasActiveLink = menu.columns.some((column) =>
    column.links.some((link) => isNavActive(link.href)),
  );
  const isWide = menu.columns.length > 1;

  // Escape closes the menu and returns focus to the trigger. Without this guard
  // the trigger's onFocus re-opens the menu the user just dismissed. Radix binds
  // its own Escape handler on `document` in the capture phase when the content
  // mounts; this listener is registered earlier, so it always runs first.
  useEffect(() => {
    const handleEscapeCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isOpenRef.current) return;
      skipFocusOpenRef.current = true;
      window.setTimeout(() => {
        skipFocusOpenRef.current = false;
      }, 0);
    };
    document.addEventListener('keydown', handleEscapeCapture, { capture: true });
    return () => document.removeEventListener('keydown', handleEscapeCapture, { capture: true });
  }, []);

  const handleValueChange = (next: string) => {
    isOpenRef.current = next === MENU_VALUE;
    setValue(next);
  };

  const handleTriggerFocus = () => {
    if (skipFocusOpenRef.current) return;
    handleValueChange(MENU_VALUE);
  };

  return (
    <NavigationMenu
      value={value}
      onValueChange={handleValueChange}
      viewport={false}
      className="max-w-none flex-none"
    >
      <NavigationMenuList>
        <NavigationMenuItem value={MENU_VALUE}>
          <NavigationMenuTrigger
            onFocus={handleTriggerFocus}
            className={cn(
              marketingButtonVariants({ variant: 'ghost', size: 'sm' }),
              'font-medium',
              hasActiveLink
                ? 'text-foreground'
                : 'text-foreground/90 hover:text-foreground data-[state=open]:text-foreground',
            )}
          >
            {name}
          </NavigationMenuTrigger>
          <NavigationMenuContent className="[&>div]:bg-transparent [&>div]:p-0">
            {/* A single-column menu is a short list, so it gets a narrow panel;
                only the two-column product menu earns the full width. */}
            <div className={cn('max-w-[calc(100vw-2.5rem)]', isWide ? 'w-[38rem]' : 'w-[15rem]')}>
              <div className={cn('grid gap-x-4 p-2', isWide && 'grid-cols-2')}>
                {menu.columns.map((column) => (
                  <div key={column.title} className="flex flex-col">
                    {/* A lone column repeats the trigger's own label, so it is
                        only worth a heading when there is a second column to
                        tell it apart from. */}
                    {isWide && (
                      <p className="text-muted-foreground px-2 pt-1.5 pb-2 text-[11px] font-medium tracking-wider uppercase">
                        {column.title}
                      </p>
                    )}
                    {column.links.map((link) => (
                      <NavigationMenuLink key={link.href} asChild active={isNavActive(link.href)}>
                        <Link
                          href={link.href}
                          {...(link.external
                            ? { target: '_blank', rel: 'noreferrer noopener' }
                            : {})}
                          className="gap-0.5 rounded-sm px-2 py-1.5"
                        >
                          <span className="text-foreground flex items-center gap-1.5 text-sm leading-tight font-medium">
                            {link.name}
                            {link.external && (
                              <ArrowUpRightIcon
                                className="text-muted-foreground size-3"
                                aria-hidden
                              />
                            )}
                          </span>
                          {link.description && (
                            <span className="text-muted-foreground text-xs leading-snug">
                              {link.description}
                            </span>
                          )}
                        </Link>
                      </NavigationMenuLink>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
