'use client';

import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import type { User } from '@supabase/supabase-js';
import { ArrowLeftRight } from 'lucide-react';
import { cn } from '@kortix/design-system';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { WorkspaceMenu } from '@/components/sidebar/workspace-menu';

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
  const pathname = usePathname();
  const onProjectsRoute = pathname?.startsWith('/projects') ?? false;

  const displayName =
    (user.user_metadata?.name as string | undefined) ||
    user.email?.split('@')[0] ||
    'User';
  const displayEmail = user.email || '';
  const avatarUrl =
    (user.user_metadata?.avatar_url as string | undefined) ||
    (user.user_metadata?.picture as string | undefined) ||
    '';

  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between gap-3 bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-6',
        variant === 'overlay' && 'pointer-events-none absolute inset-x-0 top-0 z-20 bg-transparent backdrop-blur-none',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1.5',
          variant === 'overlay' && 'pointer-events-auto',
        )}
      >
        <Link
          href="/projects"
          aria-label="Kortix"
          className="group/logo flex items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <KortixLogo
            variant="logomark"
            size={16}
            className="transition-transform duration-150 group-hover/logo:scale-105"
          />
        </Link>
        {leading}
      </div>

      <div
        className={cn(
          'flex items-center gap-3',
          variant === 'overlay' && 'pointer-events-auto',
        )}
      >
        <span
          aria-hidden
          className="hidden items-center gap-1.5 font-mono text-[0.6rem] uppercase tracking-[0.18em] text-muted-foreground/70 md:inline-flex"
        >
          <span className="size-1 rounded-full bg-emerald-400" />
          <span>Workspace</span>
        </span>
        {actions}
        <WorkspaceMenu
          user={{ name: displayName, email: displayEmail, avatar: avatarUrl }}
          variant="header"
        />
      </div>
    </header>
  );
}

export function WorkspacePickerLink({
  href = '/projects',
}: {
  href?: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 font-sans text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <ArrowLeftRight className="size-3.5" />
      Projects
    </button>
  );
}
