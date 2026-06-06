'use client';

import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuSeparator,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import { cn } from '@/lib/utils';
import { Blocks, Boxes, Radio, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { HiMiniSparkles } from 'react-icons/hi2';
import { IconType } from 'react-icons/lib';
import { MdShield } from 'react-icons/md';
import { PiClockCountdownFill, PiMonitorFill } from 'react-icons/pi';
import { TbTerminal } from 'react-icons/tb';
import { marketingButtonVariants } from '../ui/marketing/button';

export interface ProductItem {
  title: string;
  desc: string;
  href: string;
  icon: LucideIcon | IconType;
}

const PRODUCT_IMP_ITEMS: ProductItem[] = [
  {
    title: 'Kortix CLI',
    desc: 'The command center for your agents.',
    href: '/cli',
    icon: TbTerminal,
  },
  {
    title: 'Kortix Cloud',
    desc: 'The SDK for your agents.',
    href: '/web',
    icon: PiMonitorFill,
  },
];

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
              'text-foreground/90 hover:text-foreground data-[state=open]:text-foreground',
            )}
          >
            Product
          </NavigationMenuTrigger>
          <NavigationMenuContent>
            <div className="flex flex-row items-stretch gap-2">
              <div className="flex flex-col self-stretch">
                {PRODUCT_IMP_ITEMS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavigationMenuLink key={item.title} asChild className="flex-1">
                      <Link
                        href={item.href}
                        className="group/link flex h-full flex-row items-start gap-4 rounded-sm p-3 py-2 transition-colors"
                      >
                        <span className="mt-1 shrink-0">
                          <Icon className="text-muted-foreground group-hover/link:text-foreground size-6 transition-all duration-200" />
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

              <NavigationMenuSeparator orientation="vertical" />

              <div className="grid w-[34rem] grid-cols-2 gap-1">
                {PRODUCT_ITEMS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavigationMenuLink key={item.title} asChild>
                      <Link
                        href={item.href}
                        className="group/link flex flex-row items-start gap-4 rounded-sm p-3 py-2 transition-colors"
                      >
                        <span className="mt-1 shrink-0">
                          <Icon className="text-muted-foreground group-hover/link:text-foreground size-6 transition-all duration-200" />
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
            </div>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
