'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AuthCardShell, BackToSignIn } from '@/components/auth/auth-card-shell';
import { resetPassword } from '../actions';

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const code = searchParams.get('code');

  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);
    setPending(true);
    try {
      const result = await resetPassword(null, new FormData(e.currentTarget));
      if (result && typeof result === 'object' && 'success' in result && result.success) {
        setSuccess(true);
        return;
      }
      setErrorMessage((result as any)?.message || 'Could not update password');
    } catch (err: any) {
      setErrorMessage(err?.message || 'An unexpected error occurred');
    } finally {
      setPending(false);
    }
  };

  // Link missing / expired — guide the user to request a fresh one instead of
  // dead-ending on an error.
  if (!code) {
    return (
      <AuthCardShell
        title="Link expired"
        description="This password reset link is invalid or has expired"
        footer={<BackToSignIn />}
      >
        <Button asChild size="lg" className="w-full text-sm">
          <Link href="/auth/forgot-password">Request a new link</Link>
        </Button>
      </AuthCardShell>
    );
  }

  if (success) {
    return (
      <AuthCardShell
        title="Password updated"
        description="You can now sign in with your new password"
        footer={<BackToSignIn />}
      >
        <div className="mb-4 p-3 rounded-2xl flex items-center gap-2 bg-foreground/[0.05] border border-foreground/[0.08] text-foreground/80">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm">Your password has been changed.</span>
        </div>
        <Button asChild size="lg" className="w-full text-sm">
          <Link href="/auth">Go to sign in</Link>
        </Button>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title="Set a new password"
      description="Choose a new password for your account"
      footer={<BackToSignIn />}
    >
      {errorMessage && (
        <div className="mb-4 p-3 rounded-2xl flex items-center gap-2 bg-destructive/10 border border-destructive/20 text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm">{errorMessage}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          id="password"
          name="password"
          type="password"
          placeholder="New password"
          required
          autoComplete="new-password"
          className="text-sm"
        />
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          placeholder="Confirm new password"
          required
          autoComplete="new-password"
          className="text-sm"
        />
        <Button
          type="submit"
          size="lg"
          disabled={pending}
          className="w-full text-sm"
        >
          {pending ? 'Updating password…' : 'Reset password'}
        </Button>
      </form>
    </AuthCardShell>
  );
}

export default function ResetPassword() {
  return (
    <Suspense fallback={<ConnectingScreen forceConnecting minimal title="Resetting password" />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
