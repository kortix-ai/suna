'use client';

import { AccountDetailCard } from '@/components/account/account-detail-card';
import { AccountSwitcher } from '@/components/account/account-switcher';
import { InvitesSection } from '@/components/account/invites-section';
import { MembersSection } from '@/components/account/members-section';
import { ProjectsSection } from '@/components/account/projects-section';
import { ApiKeyGate } from '@/components/api-key-gate';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { getApiKey, kortix } from '@/lib/kortix';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWrapperMode } from '../providers';

/**
 * Account administration (members, invites, billing) is operator-only in
 * wrapper mode — see `src/server/policy.ts`'s `/accounts*` rule. Rather than
 * render a page whose every query 403s, wrapper mode gets a short explainer
 * back to the dashboard. Direct mode is unchanged.
 */
export default function AccountPage() {
  const wrapperMode = useWrapperMode();
  if (wrapperMode) return <WrapperAccountNotice />;
  return <DirectAccountPage />;
}

function WrapperAccountNotice() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <BrandMark className="mx-auto mb-4" />
        <h1 className="text-lg font-semibold tracking-tight">Not available in wrapper mode</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This app&apos;s wrapper backend manages the underlying Kortix account on your behalf —
          end users don&apos;t get direct account administration. See{' '}
          <Link href="/usage" className="underline">
            Usage
          </Link>{' '}
          for the cost pass-through surface instead.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link href="/">
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
        </Button>
      </Card>
    </div>
  );
}

function DirectAccountPage() {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => setReady(!!getApiKey()), []);

  if (ready === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!ready) return <ApiKeyGate onReady={() => setReady(true)} />;
  return <AccountSettings />;
}

function AccountSettings() {
  // accounts.list — the switcher + the source for the default selection.
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: () => kortix.accounts.list() });
  const accounts = accountsQ.data ?? [];

  const [accountId, setAccountId] = useState<string | null>(null);

  // Keep the selection valid: pick the first account on load, and reselect when
  // the current one disappears (e.g. after leaving it).
  useEffect(() => {
    if (accounts.length === 0) return;
    const exists = accountId && accounts.some((a) => a.account_id === accountId);
    if (!exists) setAccountId(accounts[0]?.account_id ?? null);
  }, [accounts, accountId]);

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-5 py-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back to projects
          </Link>
          <AccountSwitcher
            accounts={accounts}
            value={accountId}
            onChange={setAccountId}
            loading={accountsQ.isLoading}
          />
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Account settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your teams and personal account — members, invites, and the projects they own.
          </p>
        </div>

        <Separator className="my-6" />

        {accountsQ.isLoading && (
          <div className="space-y-4">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
        )}

        {accountsQ.isError && (
          <Card className="p-6 text-sm text-destructive">
            Couldn&apos;t load your accounts — check your API key.{' '}
            <Link className="underline" href="/">
              Go back
            </Link>
          </Card>
        )}

        {accountsQ.isSuccess && accounts.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            You have no accounts yet. Create a team account from the switcher above.
          </Card>
        )}

        {accountId && (
          <div className="space-y-8">
            <AccountDetailCard accountId={accountId} onLeft={() => setAccountId(null)} />
            <MembersSection accountId={accountId} />
            <InvitesSection accountId={accountId} />
            <ProjectsSection accountId={accountId} />
          </div>
        )}
      </div>
    </div>
  );
}
