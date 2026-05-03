'use client';

/**
 * AppHeader — the canonical top bar used outside the (dashboard) shell.
 *
 * Layout:
 *  - LEFT:  KortixLogo + optional `leading` slot (e.g. a back button).
 *  - RIGHT: optional `actions` slot + UserMenu (avatar + dropdown).
 *
 * The user menu is ALWAYS on the right — never on the left — for consistency
 * across /instances, the connecting screen, and any future top-level page.
 *
 * Owns its own UserSettingsModal so it works even when the global
 * AppProviders shell isn't mounted (e.g. during the connecting gate or on
 * the workspace picker, which is outside the (dashboard) route group).
 *
 * Variants:
 *  - default  — renders as an in-flow header (use inside a flex column page).
 *  - overlay  — renders absolutely positioned at the top of its container,
 *               sitting over a full-screen loader / shell.
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { ArrowLeftRight, ChevronDown, LogOut, Settings } from 'lucide-react';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createClient } from '@/lib/supabase/client';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { cn } from '@/lib/utils';

export function AppHeader({
  user,
  leading,
  actions,
  variant = 'default',
}: {
  user: User;
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  variant?: 'default' | 'overlay';
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deep-linking: `?settings=...` opens the modal, then cleans the URL so the
  // back button doesn't re-open it. Same behaviour everywhere this header is
  // used.
  useEffect(() => {
    if (!searchParams.get('settings')) return;
    setSettingsOpen(true);
    const clean = new URL(window.location.href);
    clean.searchParams.delete('settings');
    window.history.replaceState({}, '', `${clean.pathname}${clean.search}`);
  }, [searchParams]);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearUserLocalStorage();
    router.push('/auth');
  };

  return (
    <>
      <header
        className={cn(
          'flex items-center justify-between gap-3 px-6 py-4 shrink-0',
          variant === 'overlay' &&
            'absolute inset-x-0 top-0 z-20 pointer-events-none',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-3 min-w-0',
            variant === 'overlay' && 'pointer-events-auto',
          )}
        >
          <KortixLogo size={20} />
          {leading}
        </div>
        <div
          className={cn(
            'flex items-center gap-1.5',
            variant === 'overlay' && 'pointer-events-auto',
          )}
        >
          {actions}
          <UserMenu
            user={user}
            onOpenSettings={() => setSettingsOpen(true)}
            onLogout={handleLogout}
          />
        </div>
      </header>
      <UserSettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export function UserMenu({
  user,
  onOpenSettings,
  onLogout,
}: {
  user: User;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const avatarUrl = user.user_metadata?.avatar_url as string | undefined;
  const displayName =
    (user.user_metadata?.name as string | undefined) || user.email || 'Account';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 h-9 pl-1 pr-2 text-muted-foreground hover:text-foreground"
          aria-label="Account menu"
        >
          <Avatar className="h-7 w-7">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={displayName} />}
            <AvatarFallback className="text-[11px] bg-muted">{initial}</AvatarFallback>
          </Avatar>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5 min-w-0">
            {user.user_metadata?.name && (
              <span className="text-sm font-medium text-foreground truncate">
                {user.user_metadata.name as string}
              </span>
            )}
            {user.email && (
              <span className="text-xs text-muted-foreground truncate">{user.email}</span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSettings}>
          <Settings className="h-4 w-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogout} variant="destructive">
          <LogOut className="h-4 w-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Workspace picker link — small "Workspaces" button intended for the
 * AppHeader's `actions` slot on full-screen loader states. Provides a
 * one-click escape from an unreachable instance.
 */
export function WorkspacePickerLink({
  href = '/instances',
}: {
  href?: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
    >
      <ArrowLeftRight className="h-3.5 w-3.5" />
      Workspaces
    </button>
  );
}
