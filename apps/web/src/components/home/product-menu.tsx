'use client';

import Link from 'next/link';
import {
  Bot,
  Sparkles,
  Blocks,
  Clock,
  Radio,
  Shield,
  Boxes,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@/components/ui/navigation-menu';
import { marketingButtonVariants } from '../ui/marketing/button';

export interface ProductItem {
  title: string;
  desc: string;
  href: string;
  icon: LucideIcon;
}

export const PRODUCT_ITEMS: ProductItem[] = [
  {
    title: 'Agents',
    desc: 'A specialist agent for every role.',
    href: '/#agents',
    icon: Bot,
  },
  {
    title: 'Skills',
    desc: 'Reusable know-how every agent shares.',
    href: '/#skills',
    icon: Sparkles,
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
    icon: Clock,
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
    icon: Shield,
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
              'text-muted-foreground hover:text-foreground data-[state=open]:text-foreground ',
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
                      className="group flex flex-row items-start gap-4 rounded-sm p-3 py-2 transition-colors "
                    >
                      <span className="shrink-0 mt-1">
                        <Icon className="size-6" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">
                          {item.title}
                        </span>
                        <span className="block text-sm leading-snug text-muted-foreground">
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
