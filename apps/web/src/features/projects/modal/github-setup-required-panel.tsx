'use client';

// Shared "GitHub isn't connected yet" panel — shown in place of the
// create/import UI whenever there's no usable managed git on this server
// (self-host with no Nango connection configured yet). Routes the user to
// the account's Git settings tab.

import { Github } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';

/** Owner/admin of the account can fix a missing GitHub connection
 *  themselves (via the account's Git settings); anyone else can only ask.
 *  Copy-only signal — the settings page itself is what actually enforces
 *  authorization, so this never needs to be a hard permission check. */
export function isAccountGitAdmin(accountRole: string | null | undefined): boolean {
  return accountRole === 'owner' || accountRole === 'admin';
}

interface GitHubSetupRequiredPanelProps {
  /** Account to send the user to Git settings for. Disables the button when
   *  unresolved rather than guessing a target. */
  accountId: string | null;
  /** Owner/admin of the account → they can fix this themselves. Anyone else
   *  can only ask — the settings page itself enforces authorization, so this
   *  is just copy, not a permission check. */
  isAdmin: boolean;
  /** Called right before navigating (e.g. close the hosting modal). */
  onNavigate?: () => void;
  /** Opens Nango Connect in place. Omit this for managed-git server setup. */
  onConnect?: () => void;
  connecting?: boolean;
  secondaryAction?: ReactNode;
  size?: 'sm' | 'default';
  /** Forwarded to the underlying EmptyState wrapper — e.g. `pt-0` to collapse
   *  its own top padding when something (like the repository-source Tabs)
   *  already sits directly above it. */
  className?: string;
}

export function GitHubSetupRequiredPanel({
  accountId,
  isAdmin,
  onNavigate,
  onConnect,
  connecting = false,
  secondaryAction,
  size = 'default',
  className,
}: GitHubSetupRequiredPanelProps) {
  const router = useRouter();
  const openGitSettings = () => {
    onNavigate?.();
    if (accountId) router.push(`/accounts/${accountId}?tab=git`);
  };

  return (
    <EmptyState
      icon={Github}
      size={size}
      className={className}
      title={onConnect ? 'Connect GitHub to continue' : "GitHub isn't connected on this server yet"}
      description={
        onConnect
          ? 'Authorize a personal GitHub account or organization. A GitHub organization owner may need to approve access.'
          : isAdmin
            ? "Every Kortix project is a git repository. Connect GitHub once in this account's Git settings."
            : "Every Kortix project is a git repository. Ask your admin to connect GitHub in this account's Git settings."
      }
      action={
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={!accountId || connecting}
          onClick={onConnect ?? openGitSettings}
        >
          {connecting ? <Loading className="size-4 shrink-0" /> : <Github className="size-4" />}
          {onConnect ? 'Connect GitHub' : 'Set up GitHub'}
        </Button>
      }
      secondaryAction={secondaryAction}
    />
  );
}
