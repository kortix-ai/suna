'use client';

import { useTranslations } from '@/i18n/use-translations';

import { CheckCircleIcon as CheckCircle2 } from '@phosphor-icons/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorToast } from '@/components/ui/toast';
import { AuthCardShell, BackToSignIn } from '@/features/auth/auth-card-shell';
import { resetPassword } from '../actions';

function ResetPasswordContent() {
  const t = useTranslations('auth.passwordReset');
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
      const msg = (result as any)?.message || t('errors.updateFailed');
      setErrorMessage(msg);
      errorToast(msg);
    } catch (err: any) {
      const msg = err?.message || t('errors.unexpected');
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
        title={t('expired.title')}
        description={t('expired.description')}
        footer={<BackToSignIn />}
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/auth/forgot-password">{t('expired.requestNew')}</Link>
        </Button>
      </AuthCardShell>
    );
  }

  if (success) {
    return (
      <AuthCardShell
        title={t('success.title')}
        description={t('success.description')}
        footer={<BackToSignIn />}
      >
        <div className="border-border bg-muted/60 text-muted-foreground mb-4 flex items-center gap-2 rounded-md border px-3 py-2.5">
          <CheckCircle2 className="text-kortix-green size-4 shrink-0" />
          <span className="text-sm">{t('success.changed')}</span>
        </div>
        <Button asChild size="lg" className="w-full">
          <Link href="/auth">{t('success.signIn')}</Link>
        </Button>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={t('form.title')}
      description={t('form.description')}
      footer={<BackToSignIn />}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-3">
          <label htmlFor="password" className="text-muted-foreground text-sm font-medium">
            {t('form.newPassword')}
          </label>
          <Input
            id="password"
            aria-invalid={!!errorMessage || undefined}
            name="password"
            type="password"
            size="md"
            placeholder={t('form.newPasswordPlaceholder')}
            required
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <div className="space-y-3">
          <label htmlFor="confirmPassword" className="text-muted-foreground text-sm font-medium">
            {t('form.confirmPassword')}
          </label>
          <Input
            id="confirmPassword"
            aria-invalid={!!errorMessage || undefined}
            name="confirmPassword"
            type="password"
            size="md"
            placeholder={t('form.confirmPasswordPlaceholder')}
            required
            autoComplete="new-password"
          />
        </div>
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? t('form.updating') : t('form.submit')}
        </Button>
      </form>
    </AuthCardShell>
  );
}

export default function ResetPassword() {
  const t = useTranslations('auth.passwordReset');
  return (
    <Suspense fallback={<ConnectingScreen forceConnecting minimal title={t('resetting')} />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
