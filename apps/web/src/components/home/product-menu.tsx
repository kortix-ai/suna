'use client';

import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import { cn } from '@/lib/utils';
import { Blocks, Boxes, Radio, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { HiMiniSparkles } from 'react-icons/hi2';
import { IconType } from 'react-icons/lib';
import { MdShield } from 'react-icons/md';
import { PiClockCountdownFill } from 'react-icons/pi';
import { marketingButtonVariants } from '../ui/marketing/button';

export interface ProductItem {
  title: string;
  desc: string;
  href: string;
  icon: LucideIcon | IconType;
}

export const PRODUCT_ITEMS: ProductItem[] = [
  {
    title: 'Skills',
    desc: 'Reusable know-how every agent shares.',
    href: '/#skills',
    icon: HiMiniSparkles,
  },
  {
    title: 'Integrations',
    desc: '3,000+ tools, connected once.',
    href: '/#integrations',
    icon: Blocks,
  },
  {
    title: 'Scheduling',
    desc: 'Work that runs on a schedule, 24/7.',
    href: '/#scheduling',
    icon: PiClockCountdownFill,
  },
  {
    title: 'Channels',
    desc: 'Slack, email, web & WhatsApp.',
    href: '/#channels',
    icon: Radio,
  },
  {
    title: 'Security',
    desc: 'Roles, scoping, secrets & audit.',
    href: '/#security',
    icon: MdShield,
  },
  {
    title: 'Framework',
    desc: "The open framework it's all built on.",
    href: '/technology',
    icon: Boxes,
  },
];

export function ProductMegaMenu() {
  return (
    <NavigationMenu viewport={false} className="max-w-none flex-none">
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger
            className={cn(
              marketingButtonVariants({ variant: 'ghost', size: 'sm' }),
              'text-muted-foreground hover:text-foreground data-[state=open]:text-foreground',
            )}
          >
            Product
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <div className="grid w-[34rem] grid-cols-2 gap-1">
              {PRODUCT_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <NavigationMenuLink key={item.title} asChild>
                    <Link
                      href={item.href}
                      className="group flex flex-row items-start gap-4 rounded-sm p-3 py-2 transition-colors"
                    >
                      <span className="mt-1 shrink-0">
                        <Icon className="size-6" />
                      </span>
                      <span className="min-w-0">
                        <span className="text-foreground block text-sm font-medium">
                          {item.title}
                        </span>
                        <span className="text-muted-foreground block text-sm leading-snug">
                          {item.desc}
                        </span>
                      </span>
                    </Link>
                  </NavigationMenuLink>
                );
              })}
            </div>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
