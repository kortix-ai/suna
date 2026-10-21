'use client';

import { type Firm, useFirm } from '@/components/access';
import { BrandMark } from '@/components/brand-mark';
import { KIND, historyHref } from '@/components/runs/history-list';
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
  CaretDownIcon,
  CaretUpDownIcon,
  FolderSimpleIcon,
  NotePencilIcon,
  SquaresFourIcon,
  UserCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  GearSixIcon,
  ListIcon,
  BooksIcon,
  ChatTeardropTextIcon,
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
  { href: '/app', label: 'Assistant', icon: ChatTeardropTextIcon, exact: true },
  { href: '/app/matters', label: 'Matters', icon: BriefcaseIcon },
  { href: '/app/workflows', label: 'Workflows', icon: SquaresFourIcon },
  { href: '/app/library', label: 'Library', icon: BooksIcon },
  { href: '/app/history', label: 'History', icon: ClockCounterClockwiseIcon },
] as const;
const MATTERS_KEY = 'lumen:sidebar-matters';

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
      <div className={cn('flex h-12 items-center gap-1 pr-2 pl-4', c && 'flex-col justify-center px-0 pt-3 h-auto')}>
        <Link href="/app" aria-label="Lumen home" className="flex min-w-0 flex-1 items-center">
          <BrandMark showWordmark={!c} className="text-[17px]" />
        </Link>
        {onToggle && (
          <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={c ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggle}>
            <SidebarSimpleIcon className="size-4" />
          </Button>
        )}
      </div>

      <div className={cn('px-2 pt-1 pb-2', c && 'px-1.5')}>
        <Button
          asChild
          variant="outline"
          className={cn('h-8 w-full justify-start gap-2 rounded-md bg-card px-2.5 text-[13px] font-normal shadow-xs', c && 'justify-center px-0')}
        >
          <Link href="/app" aria-label="New chat">
            <NotePencilIcon className="size-4 shrink-0" />
            {!c && 'New chat'}
          </Link>
        </Button>
      </div>

      <nav className="flex flex-col gap-px px-2" aria-label="Main">
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            setMenu(false);
            setPalette(true);
          }}
          className={cn('flex h-8 items-center justify-start gap-2.5 rounded-md px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground', c && 'justify-center px-0')}
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
        {NAV.map((n) => (
          <NavLink key={n.href} href={n.href} label={n.label} icon={n.icon} active={active(n.href, 'exact' in n)} collapsed={c} />
        ))}
      </nav>

      {!c && <RecentMatters firm={firm} path={path} />}

      <div className="flex-1" />

      <nav className="flex flex-col gap-px px-2 pb-2" aria-label="Firm">
        <NavLink href="/app/settings" label="Settings" icon={GearSixIcon} active={active('/app/settings')} collapsed={c} />
      </nav>
      <UserMenu collapsed={c} firm={firm} />
    </>
  );

  return (
    <div className="flex h-dvh flex-col bg-background md:flex-row">
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 motion-reduce:transition-none md:flex',
          collapsed ? 'w-14' : 'w-[232px]',
        )}
      >
        {body(collapsed, toggle)}
      </aside>

      {/* Below md the sidebar is a sheet behind a top bar. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 md:hidden">
        <Button variant="ghost" size="icon" className="size-9" aria-label="Open menu" onClick={() => setMenu(true)}>
          <ListIcon className="size-5" />
        </Button>
        <Link href="/app" aria-label="Lumen home" className="flex min-w-0 flex-1 items-center">
          <BrandMark className="text-[17px]" />
        </Link>
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

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <ProvisioningBanner firm={firm} />
        {children}
      </main>

      <Palette open={palette} onOpenChange={setPalette} firm={firm} />
    </div>
  );
}

function NavLink({ href, label, icon: Icon, active, collapsed }: {
  href: string; label: string; icon: typeof ChatTeardropTextIcon; active: boolean; collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors',
        active ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && label}
    </Link>
  );
}

export function FirmLogo({ firm, className }: { firm: Pick<Firm, 'logoUrl' | 'name'>; className?: string }) {
  return firm.logoUrl ? (
    <img src={firm.logoUrl} alt="" className={cn('size-7 shrink-0 rounded-md object-cover', className)} />
  ) : (
    <div className={cn('grid size-7 shrink-0 place-items-center rounded-md bg-navy font-display text-sm text-[#F5F3EF]', className)}>
      {firm.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** The open matters, most recent first, as folders under the nav. Collapsible. */
function RecentMatters({ firm, path }: { firm: Firm; path: string }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(MATTERS_KEY) !== '0');
    } catch {
      // Storage blocked: open.
    }
  }, []);
  const matters = useQuery(api.matters.list, { firmId: firm._id, status: 'open' });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(MATTERS_KEY, o ? '0' : '1');
      } catch {
        // Storage blocked: this page only.
      }
      return !o;
    });
  return (
    <div className="mt-5 min-h-0 overflow-y-auto px-2">
      <Button
        variant="ghost"
        onClick={toggle}
        aria-expanded={open}
        className="h-6 gap-1 px-2 text-[11.5px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        Matters <CaretDownIcon className={cn('size-3 transition-transform', !open && '-rotate-90')} />
      </Button>
      {open && (
        <ul className="mt-0.5 space-y-px">
          {matters?.slice(0, 8).map((m) => {
            const href = `/app/matters/${m._id}`;
            const on = path === href || path.startsWith(`${href}/`);
            return (
              <li key={m._id}>
                <Link
                  href={href}
                  className={cn(
                    'flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors',
                    on ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                  )}
                >
                  <FolderSimpleIcon className="size-4 shrink-0" />
                  <span className="truncate">{m.name}</span>
                </Link>
              </li>
            );
          })}
          {matters?.length === 0 && <li className="px-2 py-1 text-[12px] text-muted-foreground">No open matters</li>}
          <li>
            <Link href="/app/matters/new" className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground hover:text-foreground">
              <PlusIcon className="size-4" /> New matter
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}

/** The account row: who you are, which firm you are in. Its menu switches firm, theme and signs out. */
function UserMenu({ collapsed, firm }: { collapsed: boolean; firm: Firm }) {
  const { data } = authClient.useSession();
  const orgs = authClient.useListOrganizations();
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
            aria-label="Account and firm"
          >
            <FirmLogo firm={firm} className="size-7" />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{data?.user.name || name}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {firm.name} · {roleLabel(firm.role)}
                  </span>
                </span>
                <CaretUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{data?.user.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
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
          <DropdownMenuItem onSelect={() => router.push('/onboarding?new=1')}>
            <PlusIcon className="size-4" /> New firm
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={choice} onValueChange={(v) => setChoice(v as ThemeChoice)}>
            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => router.push('/app/settings/account')}>
            <UserCircleIcon className="size-4" /> Your account
          </DropdownMenuItem>
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
  const recent = useQuery(api.workflows.firmHistory, open ? { firmId: firm._id, limit: 30 } : 'skip');
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search Lumen" description="Matters, recent questions and runs, and actions">
      <CommandInput placeholder="Search matters, questions and runs…" />
      <CommandList>
        <CommandEmpty>
          <span className="block">Nothing matches.</span>
          <span className="mt-1 block text-xs text-muted-foreground">To search inside documents, open a matter&apos;s Vault and use its search.</span>
        </CommandEmpty>
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
        {recent && recent.length > 0 && (
          <CommandGroup heading="Recent questions and runs">
            {recent.map((i) => {
              const Icon = (KIND[i.kind] ?? KIND.thread).icon;
              return (
                <CommandItem key={i._id} value={`${i.title} ${i.matterName} ${i._id}`} onSelect={() => go(historyHref(i))}>
                  <Icon className="size-4" />
                  <span className="flex-1 truncate">{i.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{i.matterName}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

