'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChevronRight, Search, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarRail,
} from '@/components/ui/sidebar';
import { ThemeToggle } from '../home/theme-toggle';

export interface DocsNavigationItem {
  id?: string;
  title: string;
  url?: string;
  href?: string;
  icon?: LucideIcon;
  badge?: string;
  isActive?: boolean;
  items?: {
    id?: string;
    title: string;
    url?: string;
    href?: string;
    isActive?: boolean;
    badge?: string;
  }[];
  children?: DocsNavigationItem[];
  defaultExpanded?: boolean;
}

export interface DocsNavigationSection {
  id: string;
  title: string;
  items: DocsNavigationItem[];
}

export interface DocsSidebarData {
  title?: string;
  subtitle?: string;
  version?: string;
  navMain: DocsNavigationItem[];
  searchPlaceholder?: string;
}

export interface DocsSidebarPropsLegacy extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  subtitle?: string;
  version?: string;
  navigation?: DocsNavigationSection[];
  showSearch?: boolean;
  searchPlaceholder?: string;
  onNavigate?: (item: any) => void;
  onSearch?: () => void;
  activeItemId?: string;
  sidebarWidth?: string;
}

export interface DocsSidebarPropsNew extends React.ComponentProps<typeof Sidebar> {
  data: DocsSidebarData;
  onNavigate?: (url: string) => void;
  onSearch?: () => void;
}

export type DocsSidebarProps = DocsSidebarPropsLegacy | DocsSidebarPropsNew;

interface NavigationItemProps {
  item: DocsNavigationItem;
  onNavigate?: (url: string) => void;
  onNavigateLegacy?: (item: any) => void;
  activeItemId?: string;
}

const NavigationItem = ({ item, onNavigate, onNavigateLegacy, activeItemId }: NavigationItemProps) => {
  const hasChildren = (item.items && item.items.length > 0) || (item.children && item.children.length > 0);
  const isActive = item.isActive || (item.id === activeItemId);
  const itemUrl = item.url || item.href;
  const childItems = item.items || item.children || [];

  const handleClick = () => {
    if (onNavigateLegacy) {
      onNavigateLegacy(item);
    } else if (itemUrl && onNavigate) {
      onNavigate(itemUrl);
    }
  };

  if (hasChildren) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton 
          tooltip={item.title}
          isActive={isActive}
        >
          {item.icon && <item.icon />}
          <span>{item.title}</span>
          {item.badge && (
            <Badge variant="outline" className="ml-auto h-5 text-xs border-border/50 text-muted-foreground">
              {item.badge}
            </Badge>
          )}
          <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
        </SidebarMenuButton>
        <SidebarMenuSub>
          {childItems.map((child) => (
            <SidebarMenuSubItem key={child.id || child.url || child.href || child.title}>
              <SidebarMenuSubButton 
                onClick={() => {
                  if (onNavigateLegacy) {
                    onNavigateLegacy(child);
                  } else {
                    const childUrl = child.url || child.href;
                    if (childUrl) onNavigate?.(childUrl);
                  }
                }}
                isActive={child.isActive || (child.id === activeItemId)}
              >
                <span>{child.title}</span>
                {child.badge && (
                  <Badge variant="outline" className="ml-auto h-5 text-xs border-border/50 text-muted-foreground">
                    {child.badge}
                  </Badge>
                )}
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton 
        onClick={handleClick}
        tooltip={item.title}
        isActive={isActive}
      >
        {item.icon && <item.icon />}
        <span>{item.title}</span>
        {item.badge && (
          <Badge variant="outline" className="ml-auto h-5 text-xs border-border/50 text-muted-foreground">
            {item.badge}
          </Badge>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

function isLegacyInterface(props: any): props is DocsSidebarPropsLegacy {
  return 'navigation' in props || 'activeItemId' in props;
}

export const DocsSidebar = React.forwardRef<
  React.ElementRef<typeof Sidebar>,
  DocsSidebarProps
>((props, ref) => {
  if (isLegacyInterface(props)) {
    const {
      title,
      subtitle,
      version,
      navigation = [],
      showSearch = true,
      searchPlaceholder,
      onNavigate,
      onSearch,
      activeItemId,
      className,
      ...restProps
    } = props;

    return (
      <div className={cn("flex h-screen flex-col border-r bg-card w-68", className)}>
        <div className="p-6 pb-4 border-b border-border/40">
          {title && (
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                <h2 className="text-lg font-semibold tracking-tight text-foreground">
                  {title}
                </h2>
              </div>
              {subtitle && (
                <p className="text-sm text-muted-foreground/80 mt-1 ml-7">
                  {subtitle}
                </p>
              )}
            </div>
          )}

          {showSearch && onSearch && (
            <Button
              variant="outline"
              onClick={onSearch}
              className="w-full justify-start px-3 text-sm text-muted-foreground border-border/60 hover:border-border hover:bg-accent/50 transition-all duration-200"
            >
              <Search className="mr-2 h-4 w-4" />
              {searchPlaceholder || "Search docs..."}
            </Button>
          )}
        </div>

        <ScrollArea className="flex-1 px-3">
          <div className="space-y-6 pb-6">
            {navigation.map((section, index) => (
              <div key={section.id} className="space-y-3">
                {section.title && (
                  <h3 className="px-3 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
                    {section.title}
                  </h3>
                )}
                <div className="space-y-1">
                  {section.items.map((item) => (
                    <Button
                      key={item.id}
                      variant="ghost"
                      onClick={() => onNavigate?.(item)}
                      className={cn(
                        "w-full justify-start h-9 px-3 font-normal text-sm transition-all duration-200",
                        item.href && "hover:bg-accent/80 hover:text-accent-foreground",
                        (item.id === activeItemId || item.isActive) && "bg-primary text-primary-foreground font-medium hover:bg-primary/90"
                      )}
                    >
                      {item.icon && <item.icon className="mr-2 h-4 w-4" />}
                      <span className="flex-1 text-left truncate">{item.title}</span>
                      {item.badge && (
                        <Badge variant="outline" className="ml-2 h-5 text-xs border-border/50 text-muted-foreground">
                          {item.badge}
                        </Badge>
                      )}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>

        {version && (
          <div className="p-6 pt-4 border-t border-border/40">
            <Badge variant="outline" className="text-xs border-border/50 text-muted-foreground/80">
              {version}
            </Badge>
          </div>
        )}
      </div>
    );
  }

  const { data, onNavigate, onSearch, ...restProps } = props as DocsSidebarPropsNew;

  return (
    <Sidebar collapsible="icon" ref={ref} {...restProps}>
      <SidebarHeader className="border-b border-border/40">
        {data?.title && (
          <div className="px-2 py-2">
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                {data.title}
              </h2>
            </div>
            {data?.subtitle && (
              <p className="text-sm text-muted-foreground/80 mt-1 ml-7">
                {data.subtitle}
              </p>
            )}
          </div>
        )}

        {onSearch && (
          <div className="px-2 pb-2">
            <Button
              variant="outline"
              onClick={onSearch}
              className="w-full justify-start px-3 text-sm text-muted-foreground border-border/60 hover:border-border hover:bg-accent/50 transition-all duration-200"
            >
              <Search className="mr-2 h-4 w-4" />
              {data?.searchPlaceholder || "Search docs..."}
            </Button>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {data?.navMain?.map((item) => (
                <NavigationItem
                  key={item.url || item.id || item.title}
                  item={item}
                  onNavigate={onNavigate}
                />
              )) || null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {data?.version && (
        <SidebarFooter className="border-t border-border/40">
          <div className="px-2 py-2">
            <Badge variant="outline" className="text-xs border-border/50 text-muted-foreground/80">
              {data.version}
            </Badge>
          </div>
        </SidebarFooter>
      )}
      <SidebarRail />
    </Sidebar>
  );
});

DocsSidebar.displayName = 'DocsSidebar'; 