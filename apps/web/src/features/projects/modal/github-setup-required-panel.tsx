'use client';

// Shared "GitHub isn't connected yet" panel — shown in place of the
// create/import UI whenever there's no usable managed git on this server
// (self-host with no GitHub App or PAT configured yet). Routes the user to
// the account's Git settings tab instead of the cloud-only "Connect the
// Kortix GitHub App" install card, which only makes sense on the hosted
// deployment (there's no hosted Kortix App to install on self-host).

import { Github } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
}

export function GitHubSetupRequiredPanel({
  accountId,
  isAdmin,
  onNavigate,
  secondaryAction,
  size = 'default',
}: GitHubSetupRequiredPanelProps) {
  const router = useRouter();

  return (
    <EmptyState
      icon={Github}
      size={size}
      title="GitHub isn't connected on this server yet"
      description={
        isAdmin
          ? "Every Kortix project is a git repository. Connect GitHub once in this account's Git settings."
          : "Every Kortix project is a git repository. Ask your admin to connect GitHub in this account's Git settings."
      }
      action={
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={!accountId}
          onClick={() => {
            onNavigate?.();
            if (accountId) router.push(`/accounts/${accountId}?tab=git`);
          }}
        >
          <Github className="size-4" />
          Set up GitHub
        </Button>
      }
      secondaryAction={secondaryAction}
    />
  );
}
