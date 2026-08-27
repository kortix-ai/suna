'use client';

// Shared "GitHub isn't connected yet" panel — shown in place of the
// create/import UI whenever there's no usable managed git on this server
// (self-host with no GitHub App or PAT configured yet). Routes the user to
// the account's Git settings tab instead of the cloud-only "Connect the
// Kortix GitHub App" install card, which only makes sense on the hosted
// deployment (there's no hosted Kortix App to install on self-host).

import { GithubLogoIcon as Github } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
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
  secondaryAction,
  size = 'default',
  className,
}: GitHubSetupRequiredPanelProps) {
  return (
    <EmptyState
      icon={Github}
      size={size}
      className={className}
      title="GitHub isn't connected on this server yet"
      description={
        isAdmin
          ? "Every Kortix project is a git repository. Connect GitHub once in this account's Git settings."
          : "Every Kortix project is a git repository. Ask your admin to connect GitHub in this account's Git settings."
      }
      action={
        // An anchor once the account resolves, so Next prefetches Git settings
        // and the click cannot degrade into a full document load. With no
        // account there is no target, so it stays a disabled button.
        accountId ? (
          <Button size="sm" className="gap-1.5" asChild>
            <Link href={`/accounts/${accountId}?tab=git`} prefetch onClick={onNavigate}>
              <Github className="size-4" />
              Set up GitHub
            </Link>
          </Button>
        ) : (
          <Button type="button" size="sm" className="gap-1.5" disabled>
            <Github className="size-4" />
            Set up GitHub
          </Button>
        )
      }
      secondaryAction={secondaryAction}
    />
  );
}
