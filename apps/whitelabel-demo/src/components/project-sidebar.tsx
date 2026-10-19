'use client';

/**
 * Lumen's project sidebar. The structure is Kortix's (`@kortix/ui/sidebar`
 * primitives, the same session list apps/web renders); the chrome is Lumen's:
 * its mark and project switcher in the header, its own pages in the nav, and
 * the signed-in identity in the footer.
 */

import { BrandMark } from '@/components/brand-mark';
import { useAccount } from '@/components/use-account';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { Button } from '@kortix/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import Hint from '@kortix/ui/hint';
import { SidebarToggle } from '@kortix/ui/icons';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@kortix/ui/sidebar';
import { ProjectSessionList } from '@kortix/ui/workspace';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme, type ThemeChoice } from '@/components/theme';
import {
  CaretUpDownIcon,
  CheckIcon,
  FolderSimpleIcon,
  GearSixIcon,
  NavigationArrowIcon,
  ReceiptIcon,
  SignOutIcon,
  SquaresFourIcon,
  UsersIcon,
} from '@phosphor-icons/react';

export function ProjectSidebar({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const nav = [
    { href: `/projects/${projectId}/sessions`, label: 'Sessions & access', icon: UsersIcon },
    { href: `/projects/${projectId}/settings`, label: 'Settings', icon: GearSixIcon },
  ];

  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarHeader className="space-y-2">
        <div className="flex w-full items-center gap-1">
          <ProjectSwitcher projectId={projectId} projectName={projectName} />
          <SidebarCollapse />
        </div>
      </SidebarHeader>

      <SidebarContent className="relative min-h-0 flex-1 overflow-hidden [&_[data-sidebar=menu-button]]:pl-2">
        <div className="flex h-full min-h-0 flex-col space-y-2">
          <SidebarGroup className="py-0">
            <SidebarMenu>
              <SidebarMenuItem>
                {/* The project home is the new-session composer, as in Kortix. */}
                <SidebarMenuButton asChild isActive={pathname === `/projects/${projectId}`}>
                  <Link href={`/projects/${projectId}`} onClick={closeOnMobile}>
                    <NavigationArrowIcon className="rotate-90" />
                    <span>New session</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {nav.map(({ href, label, icon: Icon }) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton asChild isActive={pathname === href}>
                    <Link href={href} onClick={closeOnMobile}>
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          {/* Kortix's own session list: sections, status marks, rename,
              delete, filters, and the live poll while a session starts. */}
          <SidebarGroup className="min-h-0 flex-1 flex-col py-0">
            <ProjectSessionList projectId={projectId} />
          </SidebarGroup>
        </div>
      </SidebarContent>

      <SidebarFooter>
        <AccountMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Header: Lumen's mark, the project name, and a menu to switch projects. */
function ProjectSwitcher({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const projects = useQuery({ queryKey: qk.projects, queryFn: () => kortix.projects.list() });
  const items = projects.data ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-8 min-w-0 flex-1 justify-start gap-2 px-1 text-sm font-medium"
          aria-label="Switch project"
        >
          <BrandMark showWordmark={false} className="[&_svg]:size-6" />
          <span className="min-w-0 flex-1 truncate text-left">{projectName ?? 'Project'}</span>
          <CaretUpDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Projects</DropdownMenuLabel>
        {items.slice(0, 12).map((p) => (
          <DropdownMenuItem key={p.project_id} asChild>
            <Link href={`/projects/${p.project_id}`} className="gap-2">
              <FolderSimpleIcon className="size-4" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.project_id === projectId && <CheckIcon className="size-3.5" />}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/" className="gap-2">
            <SquaresFourIcon className="size-4" /> All projects
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarCollapse() {
  const { isMobile, toggleSidebar } = useSidebar();
  if (isMobile) return null;
  return (
    <Hint label="Collapse sidebar" side="bottom">
      <Button type="button" variant="ghost" size="icon" aria-label="Collapse sidebar" onClick={toggleSidebar}>
        <SidebarToggle />
      </Button>
    </Hint>
  );
}

/** Footer: who this browser acts as, the theme, costs, and sign-out. */
function AccountMenu() {
  const account = useAccount();
  const { choice, setChoice } = useTheme();
  const initial = (account.label[0] ?? 'L').toUpperCase();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="h-10" aria-label="Account">
              <span className="bg-brand/15 text-brand grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold">
                {initial}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{account.label}</span>
                <span className="text-muted-foreground block truncate text-xs">{account.mode}</span>
              </span>
              <CaretUpDownIcon className="text-muted-foreground size-3.5" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={choice} onValueChange={(v) => setChoice(v as ThemeChoice)}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={account.wrapper ? '/session-costs' : '/account'} className="gap-2">
                {account.wrapper ? <ReceiptIcon className="size-4" /> : <UsersIcon className="size-4" />}
                {account.wrapper ? 'Session costs' : 'Account'}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={account.signOut} className="gap-2">
              <SignOutIcon className="size-4" /> {account.wrapper ? 'Sign out' : 'Disconnect'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
