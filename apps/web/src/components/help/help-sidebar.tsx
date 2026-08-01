'use client';

import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { ThemeToggle } from '../home/theme-toggle';
import { KortixLogo } from '../sidebar/kortix-logo';

const helpData = {
  navMain: [
    {
      title: 'Billing & Usage',
      items: [
        {
          title: 'What are Credits?',
          url: '/credits-explained',
        },
      ],
    },
    {
      title: 'Quick Links',
      items: [
        {
          title: 'GitHub Repository',
          url: 'https://github.com/kortix-ai/suna',
          external: true,
        },
        {
          title: 'Discord Community',
          url: 'https://discord.com/invite/RvFhXUdZ9H',
          external: true,
        },
      ],
    },
  ],
};

interface HelpSidebarProps extends React.ComponentProps<typeof Sidebar> {
  onSearchClick?: () => void;
}

export function HelpSidebar({ onSearchClick, ...props }: HelpSidebarProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const pathname = usePathname();

  const isActive = (url: string) => {
    return pathname === url;
  };

  return (
    <Sidebar
      className="[&_[data-sidebar=sidebar]]:bg-background dark:[&_[data-sidebar=sidebar]]:bg-background w-72 border-none"
      {...props}
    >
      <SidebarHeader className="space-y-3 bg-transparent p-6 px-6">
        <KortixLogo size={24} />
        {onSearchClick && (
          <Button
            variant="outline"
            className="text-muted-foreground h-12 w-full justify-between"
            onClick={onSearchClick}
          >
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4" />
              <span className="text-sm">
                {tHardcodedUi.raw('componentsHelpHelpSidebar.line80JsxTextSearchHelp')}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <div className="text-muted-foreground bg-muted flex h-7 w-7 items-center justify-center rounded-lg text-sm">
                ⌘
              </div>
              <div className="text-muted-foreground bg-muted flex h-7 w-7 items-center justify-center rounded-lg text-sm">
                K
              </div>
            </div>
          </Button>
        )}
      </SidebarHeader>
      <SidebarContent className="scrollbar-thumb-primary/20 scrollbar-thin scrollbar-track-transparent bg-transparent px-2">
        {helpData.navMain.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel className="ml-1 font-medium tracking-wide">
              {section.title}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const active = isActive(item.url);
                  return (
                    <SidebarMenuItem key={item.title}>
                      <div
                        className={cn(
                          'flex h-10 cursor-pointer items-center transition-colors',
                          active ? 'bg-muted' : 'bg-transparent',
                        )}
                      >
                        {'external' in item && item.external ? (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                              'flex w-full items-center justify-between px-3 py-2 text-sm',
                              active ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            <span className="text-primary font-medium">{item.title}</span>
                          </a>
                        ) : (
                          <Link
                            href={item.url}
                            className={cn(
                              'flex w-full items-center justify-between px-3 py-2 text-sm',
                              active ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            <span className="text-primary font-medium">{item.title}</span>
                          </Link>
                        )}
                      </div>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="flex flex-row items-center justify-between bg-transparent p-4">
        <div className="text-muted-foreground text-xs">
          {tHardcodedUi.raw('componentsHelpHelpSidebar.line142JsxTextVersion010')}
        </div>
        <ThemeToggle />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
