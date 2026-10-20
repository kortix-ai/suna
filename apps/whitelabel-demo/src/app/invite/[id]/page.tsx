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
 * with the invited email and verifies it; Better Auth refuses any other
 * account and any unverified one.
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

  const [unverified, setUnverified] = useState(false);

  useEffect(() => {
    authClient.organization.getInvitation({ query: { id: invitationId } }).then(({ data, error }) => {
      if (error?.code === 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION') setUnverified(true);
      else if (error || !data) setError(error?.message ?? 'This invitation is not valid.');
      else setInvitation(data);
    });
  }, [invitationId]);

  if (unverified) return <VerifyEmail invitationId={invitationId} />;

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
            <h1 className="font-display text-2xl tracking-tight">Invitation not available</h1>
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
            <h1 className="font-display text-2xl tracking-tight">Join {invitation.organizationName}</h1>
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

/** The invitation opens only for a verified email. The link returns here after verification. */
function VerifyEmail({ invitationId }: { invitationId: string }) {
  const { data } = authClient.useSession();
  const email = data?.user.email;
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  async function send() {
    if (!email) return;
    setState('sending');
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: `/invite/${invitationId}` });
    setState(error ? 'failed' : 'sent');
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm gap-3 p-6">
        <BrandMark className="mb-2" />
        <h1 className="font-display text-2xl tracking-tight">Verify your email</h1>
        <p className="text-sm text-muted-foreground">
          {state === 'sent'
            ? `We sent a link to ${email}. Open it to see the invitation.`
            : `Verify ${email ?? 'your email'} to open this invitation.`}
        </p>
        {state === 'failed' && (
          <p role="alert" className="text-sm text-destructive">
            The link could not be sent. Try again.
          </p>
        )}
        <Button onClick={send} disabled={!email || state === 'sending'}>
          {state === 'sending' && <Loading className="size-4" />} {state === 'sent' ? 'Send again' : 'Send verification link'}
        </Button>
      </Card>
    </div>
  );
}
