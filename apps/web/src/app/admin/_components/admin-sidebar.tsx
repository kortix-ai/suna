'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Activity,
  BarChart2,
  Bell,
  ChevronRight,
  Database,
  MessageCircle,
  ShieldCheck,
  TestTube,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
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

const LEGACY_ITEMS: NavItem[] = [
  { href: '/admin/accounts', label: 'Accounts', icon: Users },
  { href: '/admin/sandbox-pool', label: 'Sandbox pool', icon: Database },
  { href: '/admin/analytics', label: 'Analytics', icon: BarChart2 },
  { href: '/admin/feedback', label: 'Feedback', icon: MessageCircle },
  { href: '/admin/notifications', label: 'Notifications', icon: Bell },
  { href: '/admin/stress-test', label: 'Stress test', icon: TestTube },
];

export function AdminSidebar() {
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

  const legacyActive = LEGACY_ITEMS.some((item) => isActive(pathname, item.href));
  const [legacyOpen, setLegacyOpen] = useState(legacyActive);

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="border-b border-sidebar-border/60">
        <Link
          href="/admin"
          className="flex items-center gap-2 px-2 py-1.5 transition-colors hover:text-foreground"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-semibold tracking-tight">Admin</span>
            <span className="text-[11px] text-muted-foreground">Kortix console</span>
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

        <Collapsible open={legacyOpen} onOpenChange={setLegacyOpen} className="group/collapsible">
          <SidebarGroup>
            <SidebarGroupLabel asChild>
              <CollapsibleTrigger className="flex w-full items-center gap-1 hover:text-foreground transition-colors">
                <span>Legacy</span>
                <ChevronRight className="ml-auto h-3.5 w-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {LEGACY_ITEMS.map((item) => (
                    <NavLink key={item.href} item={item} pathname={pathname} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/60">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Leave admin console"
              onClick={() => router.push('/projects')}
            >
              <ArrowLeft />
              <span>Back to app</span>
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
