'use client';

import { type Firm, useFirm } from '@/components/access';
import { useTheme, type ThemeChoice } from '@/components/theme';
import { authClient } from '@/lib/auth-client';
import { isAdmin, roleLabel } from '@/lib/roles';
import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@kortix/ui/command';
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
import { Kbd } from '@kortix/ui/kbd';
import { Sheet, SheetContent, SheetTitle } from '@kortix/ui/sheet';
import Loading from '@kortix/ui/loading';
import {
  BriefcaseIcon,
  CaretUpDownIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  GearSixIcon,
  ListIcon,
  BooksIcon,
  HouseIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const COLLAPSE_KEY = 'lumen:sidebar-collapsed';

const NAV = [
  { href: '/app', label: 'Home', icon: HouseIcon, exact: true },
  { href: '/app/matters', label: 'Matters', icon: BriefcaseIcon },
  { href: '/app/library', label: 'Library', icon: BooksIcon },
  { href: '/app/history', label: 'History', icon: ClockCounterClockwiseIcon },
] as const;

/** The signed-in app: sidebar, the provisioning banner, the command palette. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const firm = useFirm();
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      // Storage blocked: start expanded.
    }
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        // Storage blocked: the choice lasts for this page only.
      }
      return !c;
    });
  };

  const active = (href: string, exact?: boolean) => (exact ? path === href : path === href || path.startsWith(`${href}/`));
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);

  const body = (c: boolean, onToggle?: () => void) => (
    <>
      <div className={cn('flex items-center gap-1 px-2 pt-3 pb-2', c && 'flex-col')}>
        <FirmSwitcher firm={firm} collapsed={c} />
        {onToggle && (
          <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={c ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggle}>
            <SidebarSimpleIcon className="size-4" />
          </Button>
        )}
      </div>

      <Button
        variant="ghost"
        type="button"
        onClick={() => {
          setMenu(false);
          setPalette(true);
        }}
        className={cn(
          'mx-2 mb-2 flex h-8 items-center justify-start gap-2 rounded-md border border-sidebar-border bg-background/60 px-2 text-sm font-normal text-muted-foreground transition-colors hover:text-foreground',
          c && 'justify-center px-0',
        )}
        aria-label="Search"
      >
        <MagnifyingGlassIcon className="size-4 shrink-0" />
        {!c && (
          <>
            <span className="flex-1 text-left">Search</span>
            <Kbd className="hidden md:inline-flex">⌘K</Kbd>
          </>
        )}
      </Button>

      <nav className="flex flex-col gap-0.5 px-2" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.href} href={n.href} label={n.label} icon={n.icon} active={active(n.href, 'exact' in n)} collapsed={c} />
        ))}
      </nav>

      <div className="flex-1" />

      <nav className="flex flex-col gap-0.5 px-2 pb-2" aria-label="Firm">
        <NavLink href="/app/settings" label="Settings" icon={GearSixIcon} active={active('/app/settings')} collapsed={c} />
      </nav>
      <UserMenu collapsed={c} />
    </>
  );

  return (
    <div className="flex h-dvh flex-col bg-background md:flex-row">
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 motion-reduce:transition-none md:flex',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        {body(collapsed, toggle)}
      </aside>

      {/* Below md the sidebar is a sheet behind a top bar. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 md:hidden">
        <Button variant="ghost" size="icon" className="size-9" aria-label="Open menu" onClick={() => setMenu(true)}>
          <ListIcon className="size-5" />
        </Button>
        <FirmLogo firm={firm} className="size-6" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{firm.name}</span>
        <Button variant="ghost" size="icon" className="size-9" aria-label="Search" onClick={() => setPalette(true)}>
          <MagnifyingGlassIcon className="size-5" />
        </Button>
      </header>
      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" showCloseButton={false} className="w-72 max-w-[85vw] gap-0 p-0">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {body(false)}
        </SheetContent>
      </Sheet>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <ProvisioningBanner firm={firm} />
        {children}
      </main>

      <Palette open={palette} onOpenChange={setPalette} firm={firm} />
    </div>
  );
}

function NavLink({ href, label, icon: Icon, active, collapsed }: {
  href: string; label: string; icon: typeof HouseIcon; active: boolean; collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors',
        active ? 'bg-sidebar-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="size-4 shrink-0" weight={active ? 'fill' : 'regular'} />
      {!collapsed && label}
    </Link>
  );
}

export function FirmLogo({ firm, className }: { firm: Pick<Firm, 'logoUrl' | 'name'>; className?: string }) {
  return firm.logoUrl ? (
    <img src={firm.logoUrl} alt="" className={cn('size-7 shrink-0 rounded-md object-cover', className)} />
  ) : (
    <div className={cn('grid size-7 shrink-0 place-items-center rounded-md bg-brand/15 font-display text-sm text-brand', className)}>
      {firm.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function FirmSwitcher({ firm, collapsed }: { firm: Firm; collapsed: boolean }) {
  const orgs = authClient.useListOrganizations();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          className={cn(
            'flex h-auto min-w-0 flex-1 items-center justify-start gap-2 rounded-md p-1 text-left font-normal transition-colors hover:bg-sidebar-accent/60',
            collapsed && 'flex-none',
          )}
          aria-label="Switch firm"
        >
          <FirmLogo firm={firm} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{firm.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{roleLabel(firm.role)}</span>
              </span>
              <CaretUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Firms</DropdownMenuLabel>
        {orgs.data?.map((o) => (
          <DropdownMenuItem
            key={o.id}
            onSelect={async () => {
              await authClient.organization.setActive({ organizationId: o.id });
              router.push('/app');
            }}
          >
            <span className="flex-1 truncate">{o.name}</span>
            {o.id === firm.orgId && <CheckIcon className="size-4 text-brand" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/onboarding?new=1')}>
          <PlusIcon className="size-4" /> New firm
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { data } = authClient.useSession();
  const { choice, setChoice } = useTheme();
  const router = useRouter();
  const name = data?.user.name || data?.user.email || '';
  return (
    <div className="border-t border-sidebar-border p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            type="button"
            className={cn('flex h-auto w-full items-center justify-start gap-2 rounded-md p-1.5 text-left font-normal transition-colors hover:bg-sidebar-accent/60', collapsed && 'justify-center')}
            aria-label="Account"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase">{name.slice(0, 1)}</span>
            {!collapsed && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{data?.user.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{data?.user.email}</span>
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={choice} onValueChange={(v) => setChoice(v as ThemeChoice)}>
            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={async () => {
              await authClient.signOut();
              router.push('/');
            }}
          >
            <SignOutIcon className="size-4" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Provisioning runs in the background: matter creation works, threads wait for it. */
function ProvisioningBanner({ firm }: { firm: Firm }) {
  const retry = useMutation(api.firms.retry);
  if (firm.status === 'ready') return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 border-b px-5 py-2 text-sm',
        firm.status === 'failed' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-border bg-muted/60 text-muted-foreground',
      )}
    >
      {firm.status === 'failed' ? <WarningIcon className="size-4" /> : <Loading className="size-4" />}
      <span className="flex-1">
        {firm.status === 'failed' ? 'Workspace setup failed.' : 'Setting up your workspace… You can create matters now; the assistant starts when setup finishes.'}
      </span>
      {firm.status === 'failed' && isAdmin(firm.role) && (
        <Button size="sm" variant="secondary" onClick={() => retry({ firmId: firm._id })}>
          Try again
        </Button>
      )}
    </div>
  );
}

function Palette({ open, onOpenChange, firm }: { open: boolean; onOpenChange: (o: boolean) => void; firm: Firm }) {
  const router = useRouter();
  const matters = useQuery(api.matters.list, open ? { firmId: firm._id } : 'skip');
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search Lumen" description="Matters and actions">
      <CommandInput placeholder="Search matters, or type a command…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => go('/app/matters/new')}>
            <PlusIcon className="size-4" /> New matter
          </CommandItem>
          <CommandItem onSelect={() => go('/app/matters')}>
            <BriefcaseIcon className="size-4" /> All matters
          </CommandItem>
          <CommandItem onSelect={() => go('/app/history')}>
            <ClockCounterClockwiseIcon className="size-4" /> History
          </CommandItem>
          <CommandItem onSelect={() => go('/app/settings/members')}>
            <GearSixIcon className="size-4" /> Members and invitations
          </CommandItem>
        </CommandGroup>
        {matters && matters.length > 0 && (
          <CommandGroup heading="Matters">
            {matters.map((m) => (
              <CommandItem key={m._id} value={`${m.name} ${m.client} ${m.number ?? ''}`} onSelect={() => go(`/app/matters/${m._id}`)}>
                <BriefcaseIcon className="size-4" />
                <span className="flex-1 truncate">{m.name}</span>
                <span className="truncate text-xs text-muted-foreground">{m.client}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

