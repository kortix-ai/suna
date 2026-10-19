'use client';

import { AuthScreen } from '@/components/auth-screen';
import { BrandMark } from '@/components/brand-mark';
import { authClient } from '@/lib/auth-client';
import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import Loading from '@kortix/ui/loading';
import { useConvexAuth } from 'convex/react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Invitation = { organizationName: string; inviterEmail: string; email: string };

/**
 * Accept an organization invitation. The recipient signs in (or signs up)
 * with the invited email; Better Auth refuses any other account.
 */
export default function InvitePage() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const id = String(useParams().id);
  if (isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Loading className="size-5 text-muted-foreground" />
      </div>
    );
  }
  if (!isAuthenticated) {
    return <AuthScreen initialMode="sign-up" subtitle="Sign in with the invited email to join the organization." />;
  }
  return <Accept invitationId={id} />;
}

function Accept({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    authClient.organization.getInvitation({ query: { id: invitationId } }).then(({ data, error }) => {
      if (error || !data) setError(error?.message ?? 'This invitation is not valid.');
      else setInvitation(data);
    });
  }, [invitationId]);

  async function accept() {
    setPending(true);
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId });
    if (error || !data) {
      setPending(false);
      return setError(error?.message ?? 'Could not accept the invitation.');
    }
    await authClient.organization.setActive({ organizationId: data.invitation.organizationId });
    router.push('/');
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm gap-3 p-6">
        <BrandMark className="mb-2" />
        {error ? (
          <>
            <h1 className="text-lg font-semibold tracking-tight">Invitation not available</h1>
            <p role="alert" className="text-sm text-muted-foreground">
              {error}
            </p>
            <Button variant="secondary" onClick={() => router.push('/')}>
              Go to Lumen
            </Button>
          </>
        ) : !invitation ? (
          <Loading className="size-5 text-muted-foreground" />
        ) : (
          <>
            <h1 className="text-lg font-semibold tracking-tight">Join {invitation.organizationName}</h1>
            <p className="text-sm text-muted-foreground">
              {invitation.inviterEmail} invited {invitation.email}.
            </p>
            <Button onClick={accept} disabled={pending}>
              {pending && <Loading className="size-4" />} Accept invitation
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
