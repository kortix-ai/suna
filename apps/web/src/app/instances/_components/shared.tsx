'use client';

/**
 * Shared chrome used across /instances and its children:
 * - InstancesTopBar: a consistent top bar (logo + account menu) used by
 *   both the listing and nested routes like /instances/[id]/backups.
 * - UserMenu: avatar-triggered account dropdown (settings + log out).
 * - ComputerHeroCard: the empty-state / claim card showing the Kortix
 *   computer image, title, description, CTA and a feature strip.
 */

import { Fragment, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { ChevronDown, Loader2, LogOut, Settings } from 'lucide-react';

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

// ─── User menu ─────────────────────────────────────────────────────────────

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

// ─── Top bar ───────────────────────────────────────────────────────────────
// Self-contained: owns its settings modal state and log-out flow, so any
// page under /instances just drops it in with a `user` prop.

export function InstancesTopBar({
  user,
  leading,
}: {
  user: User;
  /** Optional slot rendered to the left, next to the Kortix logo (e.g. a back button). */
  leading?: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deep-linking: `?settings=...` opens the modal and then cleans the URL
  // so the back button doesn't re-open it. Works from any /instances route.
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
      <header className="flex items-center justify-between px-6 py-4 shrink-0 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <KortixLogo size={20} />
          {leading}
        </div>
        <UserMenu
          user={user}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={handleLogout}
        />
      </header>
      <UserSettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

// ─── Computer hero card ────────────────────────────────────────────────────
// The empty-state / claim card used by the main listing. Rendered in two
// situations today:
//   1. First-time user who needs to create their cloud computer
//   2. Legacy paid user who needs to claim their new cloud computer
// The /debug/instances harness also renders it in isolation.

export function ComputerHeroCard({
  title,
  description,
  ctaLabel,
  ctaLoadingLabel,
  onCta,
  loading,
  features,
}: {
  title: string;
  description: React.ReactNode;
  ctaLabel: string;
  ctaLoadingLabel: string;
  onCta: () => void;
  loading: boolean;
  features: string[];
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-gradient-to-b from-background to-muted/20 px-8 py-12 flex flex-col items-center text-center gap-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/kortix-computer.png"
        alt="Kortix Computer"
        className="h-40 w-40 object-contain select-none pointer-events-none"
        draggable={false}
      />

      <div className="space-y-3 max-w-md">
        <h3 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="text-base text-muted-foreground leading-relaxed">{description}</p>
      </div>

      <Button
        size="lg"
        onClick={onCta}
        disabled={loading}
        className="gap-2 px-8 h-11 text-sm font-medium"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {ctaLoadingLabel}
          </>
        ) : (
          ctaLabel
        )}
      </Button>

      <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground/60 mt-2">
        {features.map((f, i) => (
          <Fragment key={f}>
            {i > 0 && <span className="h-3 w-px bg-border/50" aria-hidden="true" />}
            <span>{f}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
