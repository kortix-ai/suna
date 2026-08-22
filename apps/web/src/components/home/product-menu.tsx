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
import { Slack } from '@/features/icon/icons/slack';
import type { NavMenu } from '@/lib/site-config';
import { cn } from '@/lib/utils';
import type { Icon } from '@phosphor-icons/react';
import {
  ArrowUpRightIcon,
  BuildingsIcon,
  ClockClockwiseIcon,
  DesktopIcon,
  GitBranchIcon,
  HardDrivesIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/**
 * Resolves the `icon` slugs carried by nav links in `site-config.ts`. The
 * config stays a plain data module (it is imported by server code), so the
 * client-only icon components are looked up here instead of stored there.
 */
const LINK_ICONS: Record<string, Icon | typeof Slack> = {
  desktop: DesktopIcon,
  'git-branch': GitBranchIcon,
  'hard-drives': HardDrivesIcon,
  shield: ShieldCheckIcon,
  buildings: BuildingsIcon,
  plugs: PlugsConnectedIcon,
  clock: ClockClockwiseIcon,
  chats: Slack,
  users: UsersThreeIcon,
};

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
              'h-8 px-3 font-medium [&>svg]:hidden',
              'data-[state=open]:bg-secondary data-[state=open]:text-foreground data-[state=open]:hover:bg-secondary text-md',
              hasActiveLink
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {name}
          </NavigationMenuTrigger>
          <NavigationMenuContent className="[&>div]:bg-transparent [&>div]:p-0">
            {/* A single-column menu is a short list, so it gets a narrow panel;
                only the two-column product menu earns the full width. */}
            <div className={cn('max-w-[calc(100vw-2.5rem)] rounded-xl', isWide ? 'w-2xl' : 'w-60')}>
              <div className={cn('grid gap-x-3 p-1', isWide && 'grid-cols-2')}>
                {menu.columns.map((column) => (
                  <div key={column.title} className="flex flex-col gap-0.5">
                    {column.links.map((link) => {
                      const LinkIcon = link.icon ? LINK_ICONS[link.icon] : undefined;
                      return (
                        <NavigationMenuLink key={link.href} asChild active={isNavActive(link.href)}>
                          <Link
                            href={link.href}
                            {...(link.external
                              ? { target: '_blank', rel: 'noreferrer noopener' }
                              : {})}
                            className="flex-row items-center gap-3 rounded-sm p-2"
                          >
                            {/* Leading tile only when the link declares an
                                icon; the plain Company list stays a text list. */}
                            {LinkIcon && (
                              <span className="bg-foreground/5 text-foreground flex size-9 shrink-0 items-center justify-center rounded-sm">
                                <LinkIcon className="size-5" aria-hidden weight="fill" />
                              </span>
                            )}
                            <span className="flex min-w-0 flex-col gap-0.5">
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
                                <span className="text-muted-foreground truncate text-xs leading-snug">
                                  {link.description}
                                </span>
                              )}
                            </span>
                          </Link>
                        </NavigationMenuLink>
                      );
                    })}
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
