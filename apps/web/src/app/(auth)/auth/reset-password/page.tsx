'use client';

import { useTranslations } from 'next-intl';

import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';

import { AuthCardShell, BackToSignIn } from '@/features/auth/auth-card-shell';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorToast } from '@/components/ui/toast';
import { resetPassword } from '../actions';

function ResetPasswordContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      const msg = (result as any)?.message || 'Could not update password';
      setErrorMessage(msg);
      errorToast(msg);
    } catch (err: any) {
      const msg = err?.message || 'An unexpected error occurred';
      setErrorMessage(msg);
      errorToast(msg);
    } finally {
      setPending(false);
    }
  };

  // Link missing / expired — guide the user to request a fresh one instead of
  // dead-ending on an error.
  if (!code) {
    return (
      <AuthCardShell
        title={tHardcodedUi.raw('appAuthResetPasswordPage.line45JsxAttrTitleLinkExpired')}
        description={tHardcodedUi.raw(
          'appAuthResetPasswordPage.line46JsxAttrDescriptionThisPasswordResetLinkIsInvalidOrHas',
        )}
        footer={<BackToSignIn />}
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/auth/forgot-password">
            {tHardcodedUi.raw('appAuthResetPasswordPage.line50JsxTextRequestANewLink')}
          </Link>
        </Button>
      </AuthCardShell>
    );
  }

  if (success) {
    return (
      <AuthCardShell
        title={tHardcodedUi.raw('appAuthResetPasswordPage.line59JsxAttrTitlePasswordUpdated')}
        description={tHardcodedUi.raw(
          'appAuthResetPasswordPage.line60JsxAttrDescriptionYouCanNowSignInWithYourNew',
        )}
        footer={<BackToSignIn />}
      >
        <div className="border-border bg-muted/60 text-foreground/80 mb-4 flex items-center gap-2 rounded-md border px-3 py-2.5">
          <CheckCircle2 className="text-kortix-green size-4 shrink-0" />
          <span className="text-sm">
            {tHardcodedUi.raw('appAuthResetPasswordPage.line65JsxTextYourPasswordHasBeenChanged')}
          </span>
        </div>
        <Button asChild size="lg" className="w-full">
          <Link href="/auth">
            {tHardcodedUi.raw('appAuthResetPasswordPage.line68JsxTextGoToSignIn')}
          </Link>
        </Button>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={tHardcodedUi.raw('appAuthResetPasswordPage.line76JsxAttrTitleSetANewPassword')}
      description={tHardcodedUi.raw(
        'appAuthResetPasswordPage.line77JsxAttrDescriptionChooseANewPasswordForYourAccount',
      )}
      footer={<BackToSignIn />}
    >

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-3">
          <label htmlFor="password" className="text-muted-foreground text-sm font-medium">
            New password
          </label>
          <Input
            id="password"
            aria-invalid={!!errorMessage || undefined}
            name="password"
            type="password"
            size="md"
            placeholder="Your new password"
            required
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <div className="space-y-3">
          <label htmlFor="confirmPassword" className="text-muted-foreground text-sm font-medium">
            Confirm password
          </label>
          <Input
            id="confirmPassword"
            aria-invalid={!!errorMessage || undefined}
            name="confirmPassword"
            type="password"
            size="md"
            placeholder="Confirm your new password"
            required
            autoComplete="new-password"
          />
        </div>
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? 'Updating password…' : 'Reset password'}
        </Button>
      </form>
    </AuthCardShell>
  );
}

export default function ResetPassword() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <Suspense
      fallback={
        <ConnectingScreen
          forceConnecting
          minimal
          title={tHardcodedUi.raw('appAuthResetPasswordPage.line121JsxAttrTitleResettingPassword')}
        />
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}
