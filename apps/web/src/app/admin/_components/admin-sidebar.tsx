'use client';

import { useTranslations } from 'next-intl';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Activity,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export function AdminSidebar() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const pathname = usePathname();
  const router = useRouter();

  const primaryItems: NavItem[] = [
    {
      href: '/admin/ops',
      label: 'Operations',
      icon: Activity,
    },
    {
      href: '/admin/utils',
      label: 'Maintenance',
      icon: Wrench,
    },
  ];

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="border-b border-sidebar-border/60">
        <Link
          href="/admin"
          className="flex items-center gap-2 px-2 py-1.5 transition-colors hover:text-foreground"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight">Admin</span>
            <span className="text-xs text-muted-foreground">{tHardcodedUi.raw('appAdminComponentsAdminSidebar.line86JsxTextKortixConsole')}</span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {primaryItems.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/60">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={tHardcodedUi.raw('appAdminComponentsAdminSidebar.line127JsxAttrTooltipLeaveAdminConsole')}
              onClick={() => router.push('/projects')}
            >
              <ArrowLeft />
              <span>{tHardcodedUi.raw('appAdminComponentsAdminSidebar.line131JsxTextBackToApp')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string | null }) {
  const active = isActive(pathname, item.href);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link href={item.href}>
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function isActive(pathname: string | null, href: string) {
  if (!pathname) return false;
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}
