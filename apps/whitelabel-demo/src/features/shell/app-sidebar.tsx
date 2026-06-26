'use client';

import Link from 'next/link';
import { useTheme } from 'next-themes';
import { LogOut, Moon, Plus, Sun } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { UserAvatar } from '@/components/ui/user-avatar';
import { brand } from '@/config/brand';
import { logoutAction } from '@/lib/actions';
import { cn } from '@/lib/utils';

export interface SidebarRun {
  sessionId: string;
  title: string;
  mode: string;
}

export function AppSidebar({
  email,
  runs,
  activeSessionId,
}: {
  email: string;
  runs: SidebarRun[];
  activeSessionId?: string;
}) {
  return (
    <Sidebar collapsible="offcanvas" className="border-r">
      <SidebarHeader className="gap-2 p-3">
        <Link
          href="/"
          className="hover:bg-sidebar-accent flex items-center gap-2.5 rounded-lg p-1.5 transition-colors"
        >
          <BrandMark className="size-8 rounded-lg" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-semibold">{brand.workspaceName}</p>
            <p className="text-muted-foreground truncate text-xs">Workspace</p>
          </div>
          <Badge variant="muted" size="xs" className="shrink-0">
            Demo
          </Badge>
        </Link>
        <Button asChild size="sm" className="w-full justify-start gap-2">
          <Link href="/">
            <Plus className="size-4" />
            New {brand.sessionNoun}
          </Link>
        </Button>
      </SidebarHeader>

      <SidebarContent className="scrollbar-minimal px-2">
        <SidebarGroup>
          <SidebarGroupLabel>Sessions</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {runs.length === 0 ? (
                <p className="text-muted-foreground px-2 py-6 text-center text-xs">
                  No sessions yet. Start one above.
                </p>
              ) : (
                runs.map((run) => {
                  const active = run.sessionId === activeSessionId;
                  return (
                    <SidebarMenuItem key={run.sessionId}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        className="h-auto items-start py-2"
                      >
                        <Link href={`/sessions/${run.sessionId}`}>
                          <span
                            className={cn(
                              'mt-1 size-1.5 shrink-0 rounded-full',
                              active ? 'bg-foreground' : 'bg-muted-foreground/40',
                            )}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-medium">{run.title}</span>
                            <span className="text-muted-foreground truncate text-xs font-normal">
                              {run.mode} · {run.sessionId.slice(0, 8)}
                            </span>
                          </span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <UserFooter email={email} />
      </SidebarFooter>
    </Sidebar>
  );
}

function UserFooter({ email }: { email: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="hover:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors">
          <UserAvatar email={email} size="sm" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-medium">{email}</p>
            <p className="text-muted-foreground truncate text-xs">Demo account</p>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuLabel className="truncate font-normal">{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
          }}
        >
          {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" asChild>
          <button type="button" className="w-full" onClick={() => void logoutAction()}>
            <LogOut className="size-4" />
            Sign out
          </button>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
