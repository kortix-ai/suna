'use client';

import {
  navigateToPlatformHash,
  PLATFORM_SECTION_ID,
  PLATFORM_TABS,
  platformHashFromTab,
  platformTabFromHash,
  type PlatformTabId,
} from '@/components/home/platform-hash';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { Monitor, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconType } from 'react-icons/lib';
import { LuMonitorSmartphone } from 'react-icons/lu';
import { TbTerminal } from 'react-icons/tb';
import { marketingButtonVariants } from '../ui/marketing/button';

export {
  PLATFORM_SECTION_ID,
  PLATFORM_TABS,
  platformHashFromTab,
  platformTabFromHash,
  type PlatformTabId,
};

export interface ProductItem {
  title: string;
  desc: string;
  href: string;
  icon: LucideIcon | IconType;
}

export const PLATFORM_PRODUCT_ITEMS: ProductItem[] = [
  {
    title: 'CLI',
    desc: 'Run agents from your terminal.',
    href: '/#cli',
    icon: TbTerminal,
  },
  {
    title: 'Desktop',
    desc: 'Your command center on macOS, Windows, and Linux.',
    href: '/#desktop',
    icon: Monitor,
  },
  {
    title: 'Web & Mobile',
    desc: 'Ship from the browser or on the go.',
    href: '/#web-mobile',
    icon: LuMonitorSmartphone,
  },
  {
    title: 'Slack',
    desc: 'Agents where your team already talks.',
    href: '/#slack',
    icon: Icon.Slack,
  },
];

function PlatformProductLink({ item, className }: { item: ProductItem; className?: string }) {
  const pathname = usePathname();
  const ItemIcon = item.icon;

  return (
    <Link
      href={item.href}
      onClick={(event) => {
        if (navigateToPlatformHash(item.href, pathname)) {
          event.preventDefault();
        }
      }}
      className={className}
    >
      <span className="mt-1 shrink-0">
        <ItemIcon className="text-muted-foreground group-hover/link:text-foreground size-6 transition-all duration-200" />
      </span>
      <span className="min-w-0">
        <span className="text-foreground block text-sm font-medium">{item.title}</span>
        <span className="text-muted-foreground block text-sm leading-snug">{item.desc}</span>
      </span>
    </Link>
  );
}

export function ProductMegaMenu() {
  return (
    <NavigationMenu viewport={false} className="max-w-none flex-none">
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger
            className={cn(
              marketingButtonVariants({ variant: 'ghost', size: 'sm' }),
              'text-foreground/90 hover:text-foreground data-[state=open]:text-foreground',
            )}
          >
            Product
          </NavigationMenuTrigger>
          <NavigationMenuContent className="max-w-[calc(100vw-2rem)] md:w-[42rem]">
            <div className="grid grid-cols-2 gap-1 p-1">
              {PLATFORM_PRODUCT_ITEMS.map((item) => (
                <NavigationMenuLink key={item.title} asChild>
                  <PlatformProductLink
                    item={item}
                    className="group/link flex h-full flex-row items-start gap-3 rounded-lg p-3 transition-colors"
                  />
                </NavigationMenuLink>
              ))}
            </div>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
