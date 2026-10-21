'use client';

import { authClient } from '@/lib/auth-client';
import { setActiveMatter } from '@/lib/session';
import { api } from '@convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { ArrowLeftIcon, FolderDashedIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useConvexAuth, useQuery } from 'convex/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect } from 'react';

export type Firm = NonNullable<FunctionReturnType<typeof api.firms.forOrg>>;
type MatterResult = FunctionReturnType<typeof api.matters.get>;
export type MatterView = Extract<MatterResult, { access: 'ok' }>;

export function FullPageLoading() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background">
      <Loading className="size-5 text-muted-foreground" />
    </div>
  );
}

/** Children for a signed-in user; otherwise a redirect to /sign-in that comes back here. */
export function SignedIn({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace(`/sign-in?next=${encodeURIComponent(path)}`);
  }, [isLoading, isAuthenticated, router, path]);
  return isAuthenticated ? children : <FullPageLoading />;
}

/** A centered notice with one way back. */
export function Notice({ icon: Icon, title, body, href = '/app', cta = 'Back to Lumen' }: {
  icon: typeof FolderDashedIcon; title: string; body: string; href?: string; cta?: string;
}) {
  return (
    <div className="grid min-h-[60dvh] place-items-center px-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="grid size-12 place-items-center rounded-full border border-border bg-card">
          <Icon className="size-5 text-muted-foreground" />
        </div>
        <h1 className="mt-4 font-display text-2xl tracking-tight">{title}</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
        <Button asChild className="mt-5 gap-2">
          <Link href={href}>
            <ArrowLeftIcon className="size-4" /> {cta}
          </Link>
        </Button>
      </div>
    </div>
  );
}

const FirmContext = createContext<Firm | null>(null);

/** The firm of the active organization, inside /app. */
export function useFirm(): Firm {
  const firm = useContext(FirmContext);
  if (!firm) throw new Error('useFirm outside /app');
  return firm;
}

/**
 * The active organization's firm. No organization, or one whose owner has not
 * finished setup, goes to /onboarding. A fresh session with organizations but
 * none active picks the first one.
 */
export function FirmGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const orgs = authClient.useListOrganizations();
  const active = authClient.useActiveOrganization();
  const orgId = active.data?.id;
  const firm = useQuery(api.firms.forOrg, orgId ? { orgId } : 'skip');
  // A failed list (a 401 while the session cookie is swapped, after a password or two-step change) is not "no firm".
  const noOrgs = !orgs.isPending && !orgs.error && (orgs.data?.length ?? 0) === 0;
  const firstOrg = orgs.data?.[0]?.id;

  useEffect(() => {
    if (noOrgs) router.replace('/onboarding');
    else if (!active.isPending && !active.data && firstOrg) void authClient.organization.setActive({ organizationId: firstOrg });
  }, [noOrgs, active.isPending, active.data, firstOrg, router]);
  useEffect(() => {
    if (firm !== null) return;
    // `null` also shows for a moment while the session is re-issued (a two-step or password change
    // swaps the cookie and Convex re-authenticates): only a firm still missing 1.5 s later is missing.
    const t = setTimeout(() => router.replace('/onboarding'), 1500);
    return () => clearTimeout(t);
  }, [firm, router]);

  if (!firm) return <FullPageLoading />;
  return <FirmContext.Provider value={firm}>{children}</FirmContext.Provider>;
}

const MatterContext = createContext<MatterView | null>(null);

export function useMatter(): MatterView {
  const m = useContext(MatterContext);
  if (!m) throw new Error('useMatter outside a matter page');
  return m;
}

/** One matter: 403 and 404 each get their own screen. The matter becomes the SDK bearer. */
export function MatterGate({ matterId, children }: { matterId: string; children: React.ReactNode }) {
  const got = useQuery(api.matters.get, { matterId });
  if (got === undefined) return <FullPageLoading />;
  if (got.access === 'forbidden') {
    return (
      <Notice
        icon={LockKeyIcon}
        title="You don't have access to this matter"
        body="This matter is restricted. Ask its owner or a firm admin to add you."
        href="/app/matters"
        cta="All matters"
      />
    );
  }
  if (got.access === 'missing') {
    return (
      <Notice
        icon={FolderDashedIcon}
        title="Matter not found"
        body="This matter does not exist, or it belongs to another firm."
        href="/app/matters"
        cta="All matters"
      />
    );
  }
  // Set during render, before any child mounts and calls the SDK.
  setActiveMatter(got.matter._id);
  return <MatterContext.Provider value={got}>{children}</MatterContext.Provider>;
}

export const threadPath = (matterId: string, threadId: string) => `/app/matters/${matterId}/assistant/${threadId}`;
